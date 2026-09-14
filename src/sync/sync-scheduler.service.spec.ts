import { SyncSchedulerService } from './sync-scheduler.service';

describe('SyncSchedulerService', () => {
  let service: SyncSchedulerService;

  beforeEach(() => {
    service = new SyncSchedulerService({} as any, {} as any, {} as any);
  });

  it('should not schedule a connection that has never synced', () => {
    const now = new Date('2026-09-11T12:00:00.000Z');

    expect(service.isSyncDue(null, 30, now)).toBe(false);
  });

  it('should schedule a connection once its configured interval has elapsed', () => {
    const now = new Date('2026-09-11T12:00:00.000Z');
    const lastSyncAt = new Date('2026-09-11T11:20:00.000Z');

    expect(service.isSyncDue(lastSyncAt, 30, now)).toBe(true);
  });

  it('should not schedule before the interval has elapsed', () => {
    const now = new Date('2026-09-11T12:00:00.000Z');
    const lastSyncAt = new Date('2026-09-11T11:45:00.000Z');

    expect(service.isSyncDue(lastSyncAt, 30, now)).toBe(false);
  });
});
