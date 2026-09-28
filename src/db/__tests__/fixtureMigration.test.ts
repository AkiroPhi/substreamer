/**
 * Run the REAL migration chain against a REAL captured database.
 *
 * Unit tests seed the rows they expect; a captured install has the rows nobody expected,
 * and that is where the bugs have actually been. This is the headless half of
 * `sim-snapshots/README.md`: SQL-only, no simulator, fast enough to run on every change.
 *
 * WHAT THIS CANNOT DO: catch write-ordering races. better-sqlite3 applies synchronously,
 * so the adapter cannot recreate the interleaving that lost the ETL stamp on device —
 * restoring the recovery batch that caused it leaves every test here green. For that,
 * run `sim-snapshots/verify.sh` repeatedly against a booted simulator. What this DOES
 * catch is the chain or the ETL breaking on real data: real id shapes, real blob
 * contents, real row counts, none of which a seeded fixture exercises.
 *
 * SKIPS when the fixture is absent. Snapshots are gitignored — they are someone's real
 * listening history — so this is a local-only guard, not a CI gate. `./sim-snapshots/list.sh`
 * shows what is available; `verify.sh` covers the half that needs a device.
 */

import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOpSqliteMock } from '../testing/opSqliteBetterSqlite3';
import { __setDbForTests } from '../../store/persistence/db';
import { adaptForTests } from '../client';
import { ensureNormalizedSchema } from '../createNormalizedTables';

const FIXTURE = join(
  __dirname, '..', '..', '..',
  'sim-snapshots', 'substreamer-v8.0.70-74_ipad-air-m4_mig28_47dl', 'substreamer7.db',
);
const havefixture = existsSync(FIXTURE);
const maybe = havefixture ? describe : describe.skip;

if (!havefixture) {
  // eslint-disable-next-line no-console
  console.log(`[fixtureMigration] skipped — no fixture at ${FIXTURE}`);
}

/** A disposable copy, so a run never mutates the captured snapshot. */
function openFixtureCopy(): { path: string; raw: Database.Database } {
  const dir = mkdtempSync(join(tmpdir(), 'substreamer-fixture-'));
  const path = join(dir, 'substreamer7.db');
  copyFileSync(FIXTURE, path);
  return { path, raw: new Database(path) };
}

maybe('the captured v8.0.70-74 install', () => {
  it('is the shape the migration chain expects to start from', () => {
    const { raw } = openFixtureCopy();
    const counter = raw
      .prepare("SELECT value FROM storage WHERE key = 'substreamer-migration'")
      .get() as { value: string } | undefined;
    expect(JSON.parse(counter!.value).state.completedVersion).toBe(28);

    // Pre-normalized: the legacy blob tables hold the library, `songs` does not exist.
    const tables = new Set(
      (raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
        .map((r) => r.name),
    );
    expect(tables.has('song_index')).toBe(true);
    expect(tables.has('songs')).toBe(false);
    expect((raw.prepare('SELECT COUNT(*) n FROM cached_songs').get() as { n: number }).n).toBe(47);
    raw.close();
  });

  it('holds the id shapes the re-key has to handle, including the overflow case', () => {
    const { raw } = openFixtureCopy();
    const ids = (raw.prepare('SELECT song_id FROM cached_songs').all() as { song_id: string }[])
      .map((r) => r.song_id);

    // 10 are 32-hex and obviously legacy. The other 37 LOOK canonical at 22 chars, but 34
    // of them decode past 128 bits and are md5-remapped — counting by length alone said
    // "10 move" and the true answer is 44. That miscount shipped in the manifest once.
    expect(ids.filter((i) => i.length === 32)).toHaveLength(10);
    expect(ids.filter((i) => i.length === 22)).toHaveLength(37);
    raw.close();
  });

  it('runs the WHOLE migration chain, 28 to the latest, against this data', async () => {
    const { path, raw } = openFixtureCopy();
    raw.close();
    const idx = path.lastIndexOf('/');
    const op = createOpSqliteMock().open({ name: path.slice(idx + 1), location: path.slice(0, idx) });
    const handle = adaptForTests(op);
    // Production creates the normalized tables at open (`persistence/db.ts`), and this
    // fixture predates them — without this the chain fails at migration 38 on a missing
    // `genres` table, which is the harness lying, not a real defect.
    ensureNormalizedSchema(handle);
    __setDbForTests(handle);
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      const { runMigrations, LATEST_MIGRATION_ID } = require('../../services/migrationService');

      const finalVersion = await runMigrations(28);

      expect(finalVersion).toBe(LATEST_MIGRATION_ID);
      // Downloads are KEPT data and must survive the chain untouched.
      const dl = op.executeSync('SELECT COUNT(*) AS n FROM cached_songs').rows[0] as { n: number };
      expect(dl.n).toBe(47);
      // The chain does NOT populate the normalized library — that is the ETL's job, and
      // it is idle-scheduled separately.
      const before = op.executeSync('SELECT COUNT(*) AS n FROM songs').rows[0] as { n: number };
      expect(before.n).toBe(0);
    } finally {
      __setDbForTests(null);
      op.close();
    }
  }, 120_000);

  it('converts this install\'s legacy blobs into the normalized library', async () => {
    const { path, raw } = openFixtureCopy();
    const legacy = (raw.prepare('SELECT COUNT(*) n FROM song_index').get() as { n: number }).n;
    raw.close();
    const idx = path.lastIndexOf('/');
    const op = createOpSqliteMock().open({ name: path.slice(idx + 1), location: path.slice(0, idx) });
    const handle = adaptForTests(op);
    ensureNormalizedSchema(handle);
    __setDbForTests(handle);
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      const { runMigrations } = require('../../services/migrationService');
      const finalVersion = await runMigrations(28);
      // The splash persists the counter, not `runMigrations` — and the ETL gates on it
      // via `migrationChainComplete()`. Mirror that here or the ETL silently no-ops.
      op.executeSync(
        'INSERT OR REPLACE INTO storage (key, value) VALUES (?, ?);',
        ['substreamer-migration',
          JSON.stringify({ state: { completedVersion: finalVersion }, version: 0 })],
      );
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      const { runDataModelUpgradeIfNeeded } = require('../../services/dataModelUpgradeService');

      await runDataModelUpgradeIfNeeded();

      // Every legacy song row became a normalized one. This is the conversion whose
      // completion key, left unstamped, reimported the whole lot a second time.
      const songs = op.executeSync('SELECT COUNT(*) AS n FROM songs').rows[0] as { n: number };
      expect(songs.n).toBe(legacy);
      const stamp = op.executeSync(
        "SELECT value FROM storage WHERE key = 'substreamer-normalized-migration-complete'",
      ).rows[0] as { value: string } | undefined;
      expect(stamp?.value).toBe('3');
    } finally {
      __setDbForTests(null);
      op.close();
    }
  }, 180_000);
});
