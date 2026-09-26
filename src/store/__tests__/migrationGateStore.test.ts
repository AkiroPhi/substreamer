import { migrationGateStore } from '../migrationGateStore';

beforeEach(() => migrationGateStore.getState().reset());

describe('migrationGateStore', () => {
  it('starts hidden', () => {
    expect(migrationGateStore.getState().visible).toBe(false);
  });

  it('tracks stage progress', () => {
    const s = migrationGateStore.getState();
    s.show('working');
    s.beginStage('movingFiles', 47);
    s.advanceStage('movingFiles', 44);
    const { stages, activeStage } = migrationGateStore.getState();
    expect(activeStage).toBe('movingFiles');
    expect(stages.movingFiles).toEqual({ id: 'movingFiles', total: 47, done: 44 });
  });

  it('latches hasWritten so a failure after the first write cannot be walked away from', () => {
    const s = migrationGateStore.getState();
    s.show('working');
    expect(migrationGateStore.getState().hasWritten).toBe(false);
    s.markWritten();
    s.fail();
    const next = migrationGateStore.getState();
    expect(next.hasWritten).toBe(true);
    expect(next.failed).toBe(true);
  });
});

describe('the completion state', () => {
  // A one-shot irreversible migration should end with the user SEEING it finished,
  // not with a screen that silently vanishes.
  it('stays visible after complete()', () => {
    const s = migrationGateStore.getState();
    s.show('working');
    s.beginStage('movingFiles', 47);
    s.complete();

    const next = migrationGateStore.getState();
    expect(next.visible).toBe(true);
    expect(next.mode).toBe('complete');
    expect(next.activeStage).toBeNull();
    expect(next.failed).toBe(false);
  });

  it('hides only when the user dismisses it', () => {
    migrationGateStore.getState().show('working');
    migrationGateStore.getState().complete();
    migrationGateStore.getState().hide();
    expect(migrationGateStore.getState().visible).toBe(false);
  });

  it('clears a stale failure so a retried run ends clean', () => {
    const s = migrationGateStore.getState();
    s.show('working');
    s.fail();
    s.complete();
    expect(migrationGateStore.getState().failed).toBe(false);
  });
});
