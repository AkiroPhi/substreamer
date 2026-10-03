import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { Cursor } from '../../db/repository/core';
import { useKeysetList } from '../useKeysetList';

interface Row {
  id: string;
}

/** A paged source over a fixed array, driven by the same cursor shape the repository
 *  emits (`{ sortKey, id }`). */
function pagedSource(ids: string[], pageSize: number) {
  const calls: (Cursor | null)[] = [];
  const loadPage = async (cursor: Cursor | null) => {
    calls.push(cursor);
    const start = cursor ? ids.indexOf(cursor.id) + 1 : 0;
    const rows = ids.slice(start, start + pageSize).map((id) => ({ id }));
    const last = rows[rows.length - 1];
    const more = last != null && ids.indexOf(last.id) < ids.length - 1;
    return { rows, nextCursor: more ? { sortKey: 0, id: last.id } : null };
  };
  return { loadPage, calls };
}

describe('useKeysetList', () => {
  it('loads the first page on mount and clears initialLoading', async () => {
    const { loadPage } = pagedSource(['a', 'b', 'c'], 2);
    const { result } = renderHook(() => useKeysetList<Row>(loadPage));
    await waitFor(() => expect(result.current.initialLoading).toBe(false));
    expect(result.current.rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('appends on loadMore until the source is exhausted', async () => {
    const { loadPage, calls } = pagedSource(['a', 'b', 'c', 'd', 'e'], 2);
    const { result } = renderHook(() => useKeysetList<Row>(loadPage));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.rows).toHaveLength(4));

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.rows).toHaveLength(5));

    // Exhausted: further calls are refused, so the source is not re-queried.
    const before = calls.length;
    await act(async () => {
      result.current.loadMore();
    });
    expect(calls.length).toBe(before);
  });

  it('reload restarts from the first page', async () => {
    let ids = ['a', 'b'];
    const loadPage = async (cursor: Cursor | null) => {
      const start = cursor ? ids.indexOf(cursor.id) + 1 : 0;
      return { rows: ids.slice(start).map((id) => ({ id })), nextCursor: null };
    };
    const { result } = renderHook(() => useKeysetList<Row>(loadPage));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    ids = ['x'];
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(['x']));
  });

  it('reloads from the top when loadPage identity changes (a filter flip)', async () => {
    const first = pagedSource(['a', 'b'], 5);
    const second = pagedSource(['z'], 5);
    const { result, rerender } = renderHook(
      ({ load }: { load: typeof first.loadPage }) => useKeysetList<Row>(load),
      { initialProps: { load: first.loadPage } },
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    rerender({ load: second.loadPage });
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(['z']));
  });

  it('does not re-enter while a page is in flight', async () => {
    let resolve: (() => void) | null = null;
    const calls: number[] = [];
    const loadPage = async () => {
      calls.push(1);
      await new Promise<void>((r) => {
        resolve = r;
      });
      return { rows: [{ id: 'a' }], nextCursor: { sortKey: 0, id: 'a' } };
    };
    const { result } = renderHook(() => useKeysetList<Row>(loadPage));
    // The mount load is still pending; loadMore must not start a second one.
    act(() => {
      result.current.loadMore();
    });
    expect(calls).toHaveLength(1);
    await act(async () => {
      resolve?.();
    });
  });
  describe('a load that lands after a restart', () => {
    /** Each call parks until the test resolves it, in any order. */
    function deferredSource() {
      const pending: Array<{ cursor: Cursor | null; resolve: (p: { rows: Row[]; nextCursor: Cursor | null }) => void }> = [];
      const loadPage = (cursor: Cursor | null) =>
        new Promise<{ rows: Row[]; nextCursor: Cursor | null }>((resolve) => {
          pending.push({ cursor, resolve });
        });
      return { loadPage, pending };
    }

    it('drops a first page from the previous loadPage', async () => {
      const first = deferredSource();
      const second = deferredSource();
      const { result, rerender } = renderHook(
        ({ load }: { load: typeof first.loadPage }) => useKeysetList<Row>(load),
        { initialProps: { load: first.loadPage } },
      );
      rerender({ load: second.loadPage });
      await act(async () => {
        second.pending[0].resolve({ rows: [{ id: 'new' }], nextCursor: null });
      });
      await act(async () => {
        first.pending[0].resolve({ rows: [{ id: 'old' }], nextCursor: { sortKey: 0, id: 'old' } });
      });
      expect(result.current.rows.map((r) => r.id)).toEqual(['new']);
      expect(result.current.initialLoading).toBe(false);
      // The stale page's cursor did not leak: the new list is exhausted.
      act(() => result.current.loadMore());
      expect(second.pending).toHaveLength(1);
    });

    it('drops a loadMore page that lands after reload', async () => {
      const src = deferredSource();
      const { result } = renderHook(() => useKeysetList<Row>(src.loadPage));
      await act(async () => {
        src.pending[0].resolve({ rows: [{ id: 'a' }], nextCursor: { sortKey: 0, id: 'a' } });
      });
      act(() => result.current.loadMore());
      expect(src.pending).toHaveLength(2);

      act(() => result.current.reload());
      await act(async () => {
        src.pending[2].resolve({ rows: [{ id: 'r' }], nextCursor: { sortKey: 0, id: 'r' } });
      });
      await act(async () => {
        src.pending[1].resolve({ rows: [{ id: 'stale' }], nextCursor: null });
      });
      expect(result.current.rows.map((r) => r.id)).toEqual(['r']);

      // The stale loadMore neither marked the list done nor left it busy.
      act(() => result.current.loadMore());
      expect(src.pending).toHaveLength(4);
      expect(src.pending[3].cursor).toEqual({ sortKey: 0, id: 'r' });
      await act(async () => {
        src.pending[3].resolve({ rows: [{ id: 's' }], nextCursor: null });
      });
      expect(result.current.rows.map((r) => r.id)).toEqual(['r', 's']);
    });
  });
});
