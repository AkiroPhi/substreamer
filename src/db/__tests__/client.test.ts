/**
 * `runAtomicBatchAsync` — the all-or-nothing bulk-write primitive.
 *
 * `runBatchAsync` is N statements in AUTOCOMMIT (op-SQLite leaves the transaction to
 * the caller), so a delete-then-insert rebuild that fails part-way leaves the delete
 * applied. These assert the SAVEPOINT bracketing, the rollback, and that the ORIGINAL
 * statement error is what callers see — including when the rollback itself fails, which
 * is what `SQLITE_FULL`/`IOERR`/`NOMEM` do (they abort the whole transaction, after
 * which `ROLLBACK TO` reports "no such savepoint").
 *
 * They also pin the ORDER the two batches are issued in. An aborted batch never reaches
 * its RELEASE, so recovering from the JS `catch` would leave the savepoint open across a
 * round trip to JS and let the pool commit other writers' work inside it, to be discarded
 * by the ROLLBACK. The recovery is therefore enqueued unconditionally in the same tick —
 * on the success path it is a no-op that fails with "no such savepoint". The substitute parks
 * both on op-SQLite's transaction lock, so the ISSUE order and the RUN order are both
 * checkable here; what stays device-only is the native pool draining underneath.
 */
import { settleDbWrites } from '../../test-utils/settleDbWrites';

import { awaitDbWritesIdle, openDbConnection } from '../client';

import type { SQLBatchTuple } from '@op-engineering/op-sqlite';

function freshDb() {
  const conn = openDbConnection();
  conn.raw.executeSync('CREATE TABLE t (id TEXT PRIMARY KEY)');
  return conn;
}

const ids = (conn: ReturnType<typeof freshDb>): string[] =>
  conn.db.getAllSync<{ id: string }>('SELECT id FROM t ORDER BY id').map((r) => r.id);

describe('runAtomicBatchAsync', () => {
  it('brackets the caller commands in SAVEPOINT … RELEASE', async () => {
    const conn = freshDb();
    const spy = jest.spyOn(conn.raw, 'executeBatch');

    await conn.db.runAtomicBatchAsync([['INSERT INTO t VALUES (?)', ['a']]]);

    const sent = spy.mock.calls[0][0] as SQLBatchTuple[];
    expect(sent[0][0]).toBe('SAVEPOINT op_batch');
    expect(sent[sent.length - 1][0]).toBe('RELEASE op_batch');
    expect(sent).toHaveLength(3);
    expect(ids(conn)).toEqual(['a']);
    conn.raw.close();
  });

  it('issues exactly ONE batch, so nothing of its own can roll a later write back', async () => {
    const conn = freshDb();
    const spy = jest.spyOn(conn.raw, 'executeBatch');

    void conn.db.runAtomicBatchAsync([['INSERT INTO t VALUES (?)', ['a']]]);

    // No await: the batch must already be issued, because the pipelining caller
    // `bulkUpsert` derives its next chunk before this one would otherwise land.
    // Exactly one — a second "recovery" batch used to follow, and on the success path
    // its failing ROLLBACK TO made op-SQLite's wrapper fire a real ROLLBACK, discarding
    // whatever any other caller had written in the meantime.
    expect(spy).toHaveBeenCalledTimes(1);
    await settleDbWrites();
    conn.raw.close();
  });

  it('keeps a write issued alongside an un-awaited batch', async () => {
    const conn = freshDb();

    // The shape that lost the write on device: the batch is NOT awaited, so the
    // follow-up write is issued while the batch's dispatch is still pending.
    //
    // This asserts the contract, it does NOT reproduce the bug — better-sqlite3 applies
    // synchronously, so the adapter cannot recreate the interleaving where a second
    // batch's ROLLBACK lands between these two. The structural guard is the
    // "exactly ONE batch" test above; the behavioural evidence is device cycles
    // (5 of 5 lost the write with the recovery batch, 7 of 7 kept it without).
    const batch = conn.db.runAtomicBatchAsync([['INSERT INTO t VALUES (?)', ['batched']]]);
    await conn.db.runAsync('INSERT INTO t VALUES (?)', ['after']);
    await batch;
    await settleDbWrites();

    expect(ids(conn)).toEqual(['after', 'batched']);
    conn.raw.close();
  });

  it('skips the connection entirely for an empty command list', async () => {
    const conn = freshDb();
    const spy = jest.spyOn(conn.raw, 'executeBatch');

    await conn.db.runAtomicBatchAsync([]);

    expect(spy).not.toHaveBeenCalled();
    conn.raw.close();
  });

  it('rolls the whole batch back on a mid-batch failure and rethrows the statement error', async () => {
    const conn = freshDb();
    await conn.db.runAtomicBatchAsync([['INSERT INTO t VALUES (?)', ['keep']]]);
    const spy = jest.spyOn(conn.raw, 'executeBatch');

    await expect(
      conn.db.runAtomicBatchAsync([
        ['DELETE FROM t', []],
        ['INSERT INTO t VALUES (?)', ['new']],
        ['INSERT INTO no_such_table VALUES (?)', ['boom']],
      ]),
    ).rejects.toThrow(/no_such_table/);

    // The DELETE and the INSERT both ran before the failure; only a real ROLLBACK TO
    // can put the previous row back.
    // Atomicity comes from op-SQLite's own BEGIN/COMMIT/ROLLBACK wrapper, not from any
    // scaffolding of ours: one batch in, nothing half-applied.
    expect(ids(conn)).toEqual(['keep']);
    expect(spy).toHaveBeenCalledTimes(1);
    conn.raw.close();
  });

  it('leaves no open savepoint — the next write and a fresh BEGIN both succeed', async () => {
    const conn = freshDb();
    await expect(
      conn.db.runAtomicBatchAsync([['INSERT INTO no_such_table VALUES (?)', ['boom']]]),
    ).rejects.toThrow();

    // A stranded savepoint would make this BEGIN "cannot start a transaction within a
    // transaction" — the failure mode that takes `resetNormalizedSchema` down.
    conn.db.withTransactionSync(() => {
      conn.db.runSync('INSERT INTO t VALUES (?)', ['after']);
    });
    await conn.db.runAtomicBatchAsync([['INSERT INTO t VALUES (?)', ['after2']]]);

    expect(ids(conn)).toEqual(['after', 'after2']);
    conn.raw.close();
  });

  it('counts the recovery as in-flight, so idle means the pool really is quiet', async () => {
    const conn = freshDb();
    let finishRecovery!: (r: unknown) => void;
    const pending = new Promise((resolve) => {
      finishRecovery = resolve;
    });
    jest
      .spyOn(conn.raw, 'executeBatch')
      .mockReturnValueOnce(Promise.resolve({ rowsAffected: 1 }))
      .mockReturnValueOnce(pending as never);

    await conn.db.runAtomicBatchAsync([['INSERT INTO t VALUES (?)', ['a']]]);
    const idle = awaitDbWritesIdle().then(() => 'idle');
    const waiting = Symbol('waiting');
    expect(await Promise.race([idle, Promise.resolve(waiting)])).toBe(waiting);

    finishRecovery({ rowsAffected: 0 });
    expect(await idle).toBe('idle');
    conn.raw.close();
  });

  it('swallows a failing recovery and still reports the original error', async () => {
    const conn = freshDb();
    const original = new Error('disk is full');
    jest
      .spyOn(conn.raw, 'executeBatch')
      .mockRejectedValueOnce(original)
      .mockRejectedValueOnce(new Error('no such savepoint: op_batch'));

    await expect(
      conn.db.runAtomicBatchAsync([['INSERT INTO t VALUES (?)', ['a']]]),
    ).rejects.toBe(original);
    conn.raw.close();
  });
});

/**
 * The quiesce logout waits on before its JS-thread `BEGIN`. It TRACKS writes rather
 * than serializing them, and it replaced a drain of a JS-side write mutex that could
 * only ever see the writers which had opted into that chain.
 */
describe('awaitDbWritesIdle', () => {
  it('resolves immediately when nothing is in flight', async () => {
    await expect(awaitDbWritesIdle()).resolves.toBeUndefined();
  });

  it('does not resolve while a write is outstanding', async () => {
    const conn = freshDb();
    let finish!: (r: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    jest.spyOn(conn.raw, 'execute').mockReturnValueOnce(pending as never);

    const write = conn.db.runAsync('INSERT INTO t VALUES (?)', ['a']);
    const idle = awaitDbWritesIdle().then(() => 'idle');
    const waiting = Symbol('waiting');
    expect(await Promise.race([idle, Promise.resolve(waiting)])).toBe(waiting);

    finish({ rows: [], rowsAffected: 1, insertId: 0 });
    await write;
    expect(await idle).toBe('idle');
    conn.raw.close();
  });

  it('resolves after an in-flight write REJECTS — a failed write must not hang logout', async () => {
    const conn = freshDb();
    let fail!: (e: Error) => void;
    const pending = new Promise((_resolve, reject) => {
      fail = reject;
    });
    jest.spyOn(conn.raw, 'execute').mockReturnValueOnce(pending as never);

    const write = conn.db.runAsync('INSERT INTO t VALUES (?)', ['a']);
    const idle = awaitDbWritesIdle();
    fail(new Error('disk is full'));

    await expect(write).rejects.toThrow('disk is full');
    await expect(idle).resolves.toBeUndefined();
    conn.raw.close();
  });
});
