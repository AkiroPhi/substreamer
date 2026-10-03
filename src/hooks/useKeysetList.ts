import { useCallback, useEffect, useRef, useState } from 'react';

import type { Cursor } from '../db/repository/core';

export interface KeysetPageResult<T> {
  rows: T[];
  nextCursor: Cursor | null;
}

export interface KeysetList<T> {
  rows: T[];
  initialLoading: boolean;
  loadMore: () => void;
  reload: () => void;
}

/**
 * Forward-only keyset pagination for a SQL-backed list — no `loadPrevious`, no
 * `seekLetter`. Its callers (Favourites, the scrobble history) order by time, so they
 * have no alphabet scroller and never seek or page backward; the A–Z browse screens
 * keep their own richer loops.
 *
 * `loadPage` must be stable (a `useCallback`); it is the reload key.
 */
export function useKeysetList<T>(
  loadPage: (cursor: Cursor | null) => Promise<KeysetPageResult<T>>,
): KeysetList<T> {
  const [rows, setRows] = useState<T[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const cursorRef = useRef<Cursor | null>(null);
  const doneRef = useRef(false);
  const busyRef = useRef(false);
  // Bumped on every restart. A load that lands after a restart writes nothing, so an
  // earlier filter's page can't replace or append to the current one.
  const genRef = useRef(0);

  const loadFirstPage = useCallback(async () => {
    const gen = ++genRef.current;
    cursorRef.current = null;
    doneRef.current = false;
    busyRef.current = true;
    try {
      const page = await loadPage(null);
      if (gen !== genRef.current) return;
      cursorRef.current = page.nextCursor;
      doneRef.current = !page.nextCursor;
      setRows(page.rows);
    } finally {
      if (gen === genRef.current) {
        busyRef.current = false;
        setInitialLoading(false);
      }
    }
  }, [loadPage]);

  const loadMore = useCallback(() => {
    if (busyRef.current || doneRef.current) return;
    const gen = genRef.current;
    busyRef.current = true;
    void (async () => {
      try {
        const page = await loadPage(cursorRef.current);
        if (gen !== genRef.current) return;
        cursorRef.current = page.nextCursor;
        if (!page.nextCursor) doneRef.current = true;
        setRows((r) => [...r, ...page.rows]);
      } finally {
        if (gen === genRef.current) busyRef.current = false;
      }
    })();
  }, [loadPage]);

  const reload = useCallback(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  useEffect(() => {
    setInitialLoading(true);
    void loadFirstPage();
  }, [loadFirstPage]);

  return { rows, initialLoading, loadMore, reload };
}
