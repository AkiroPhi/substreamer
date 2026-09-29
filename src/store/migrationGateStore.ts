/**
 * State for the blocking migration screen shown between the splash and the app, plus the
 * one flag describing a pass that was needed and did NOT run.
 *
 * Deliberately NOT persisted: it describes a run in progress, and a run that did not
 * finish is re-detected from its own marker on the next launch rather than resumed from
 * UI state.
 *
 * Holding the app behind this screen is also what removes the need for a pause flag
 * consulted across the codebase — while it is up, `_layout`'s startup effects have not
 * run, so nothing is racing the work it is reporting on.
 */

import { create } from 'zustand';

/** A named unit of work the screen reports on, in the order it runs. */
export type MigrationStageId =
  /** Held because another one-shot job is mid-flight; mirrors that job's progress. */
  | 'waitingForTasks'
  | 'preparing'
  | 'updatingDownloads'
  | 'movingFiles'
  | 'refreshingArtwork'
  | 'finishing';

export interface MigrationStage {
  id: MigrationStageId;
  /** Present only for stages with a countable unit of work — the file move, chiefly. */
  total?: number;
  done?: number;
}

/**
 * `working`  — running; reports progress and cannot be dismissed.
 * `asking`   — the server's version cannot settle whether the re-key is needed, so the
 *   user decides. They know whether they updated their server; we do not.
 * `offering` — we KNOW it is needed, but the app is already running and in use. A cold
 *   start just runs; interrupting a live session asks first.
 * `complete` — finished, waiting to be dismissed.
 */
export type MigrationGateMode = 'working' | 'asking' | 'offering' | 'complete';

interface MigrationGateState {
  /** True while the app must stay behind the screen. */
  visible: boolean;
  mode: MigrationGateMode;
  /** The stage currently running, or null before the first one starts. */
  activeStage: MigrationStageId | null;
  /** Per-stage progress, keyed by stage id. */
  stages: Partial<Record<MigrationStageId, MigrationStage>>;
  /** Set when the run failed; the screen surfaces a retry rather than hanging. */
  failed: boolean;
  /**
   * The re-key is needed but has not run — no reachable server, or the user chose Later.
   * The app stays usable and stale: library writes are refused for the whole session, so
   * this is what lets a surface explain a Sync button that would otherwise do nothing.
   */
  deferred: boolean;
  /**
   * True once the run has committed a write. A failure BEFORE any write is safe to walk
   * away from; a failure after one leaves the database re-keyed with files still at their
   * old paths, and launching into that lets the reconcile delete every download.
   */
  hasWritten: boolean;

  show: (mode?: MigrationGateMode) => void;
  hide: () => void;
  /** The user confirmed from `asking`; the caller starts the pass. */
  confirm: () => void;
  /** Clear the failure so a retry can re-run the stages. */
  clearFailure: () => void;
  /** Record, or clear, "needed but not run". Set on a deferral, cleared when one starts. */
  setDeferred: (deferred: boolean) => void;
  beginStage: (id: MigrationStageId, total?: number) => void;
  advanceStage: (id: MigrationStageId, done: number) => void;
  fail: () => void;
  /** Called immediately before the first write of the run. */
  markWritten: () => void;
  /**
   * The pass finished. Switches to the completion screen rather than hiding: a one-shot
   * irreversible migration should end with the user SEEING that it finished, not with a
   * screen that silently vanishes. The user dismisses it with `hide`.
   */
  complete: () => void;
  reset: () => void;
}

const initial = {
  visible: false,
  mode: 'working' as MigrationGateMode,
  hasWritten: false,
  deferred: false,
  activeStage: null as MigrationStageId | null,
  stages: {} as Partial<Record<MigrationStageId, MigrationStage>>,
  failed: false,
};

export const migrationGateStore = create<MigrationGateState>()((set) => ({
  ...initial,

  show: (mode = 'working') => set({ visible: true, mode, failed: false }),
  hide: () => set({ visible: false }),
  confirm: () => set({ mode: 'working' }),
  clearFailure: () => set({ failed: false, activeStage: null, stages: {} }),
  setDeferred: (deferred) => set({ deferred }),

  beginStage: (id, total) =>
    set((s) => ({
      activeStage: id,
      stages: { ...s.stages, [id]: { id, total, done: total === undefined ? undefined : 0 } },
    })),

  // Guarded against a caller reporting progress for a stage that never began, which would
  // otherwise render a bar with no total.
  advanceStage: (id, done) =>
    set((s) => (s.stages[id] === undefined
      ? s
      : { stages: { ...s.stages, [id]: { ...s.stages[id], done } } })),

  fail: () => set({ failed: true }),
  markWritten: () => set({ hasWritten: true }),
  complete: () => set({ mode: 'complete', activeStage: null, failed: false }),
  reset: () => set({ ...initial, stages: {} }),
}));

/** Non-reactive read for services that must not subscribe. */
export const isMigrationGateVisible = (): boolean => migrationGateStore.getState().visible;
