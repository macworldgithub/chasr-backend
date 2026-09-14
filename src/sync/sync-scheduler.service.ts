// src/sync/sync-scheduler.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AccountingConnection } from '../integrations/schemas/accounting-connection.schema';
import { SyncLog } from '../integrations/schemas/sync-log.schema';
import { SyncOrchestratorService } from './sync-orchestrator.service';

@Injectable()
export class SyncSchedulerService {
  private readonly logger = new Logger(SyncSchedulerService.name);

  constructor(
    @InjectModel(AccountingConnection.name)
    private readonly connectionModel: Model<AccountingConnection>,
    @InjectModel(SyncLog.name)
    private readonly syncLogModel: Model<SyncLog>,
    private readonly orchestrator: SyncOrchestratorService,
  ) {}

  isSyncDue(
    lastSyncAt: Date | null | undefined,
    syncFrequencyMinutes: number | undefined,
    now: Date = new Date(),
  ): boolean {
    const frequencyMinutes = Number(syncFrequencyMinutes ?? 30);

    if (
      !lastSyncAt ||
      !Number.isFinite(frequencyMinutes) ||
      frequencyMinutes <= 0
    ) {
      return false;
    }

    const dueAt = new Date(lastSyncAt.getTime() + frequencyMinutes * 60_000);
    return dueAt <= now;
  }

  /**
   * Runs every 5 minutes. Finds connections whose
   * lastSyncAt + syncFrequencyMinutes <= now.
   *
   * Never-synced connections are intentionally excluded so they do not
   * get re-queued forever every scheduler tick.
   */
  @Cron('*/5 * * * *')
  async scheduledSyncCheck(): Promise<void> {
    const now = new Date();

    let dueConnections: AccountingConnection[];
    try {
      dueConnections = await this.connectionModel.aggregate([
        {
          $match: {
            status: 'connected',
            isDeleted: false,
            provider: { $in: ['xero', 'quickbooks'] },
            'credentials.encryptedAccessToken': {
              $exists: true,
              $nin: [null, ''],
            },
            'credentials.encryptedRefreshToken': {
              $exists: true,
              $nin: [null, ''],
            },
          },
        },
        {
          $addFields: {
            nextSyncDue: {
              $add: [
                '$lastSyncAt',
                { $multiply: ['$settings.syncFrequencyMinutes', 60_000] },
              ],
            },
          },
        },
        {
          $match: {
            lastSyncAt: { $ne: null },
            nextSyncDue: { $lte: now },
          },
        },
      ]);
    } catch (err) {
      this.logger.error(
        `Failed to query connections for scheduled sync: ${err.message}`,
      );
      return;
    }

    if (dueConnections.length === 0) return;

    this.logger.log(
      `Scheduled sync check: ${dueConnections.length} connection(s) due`,
    );

    for (const connection of dueConnections) {
      try {
        // Create SyncLog before dispatching (scheduler owns log creation)
        const syncLog = await this.syncLogModel.create({
          connectionId: connection._id,
          orgId: connection.orgId,
          triggerType: 'scheduled',
          status: 'started',
          actor: 'system',
          startedAt: new Date(),
        });

        await this.orchestrator.dispatchIncrementalSync(
          connection._id.toString(),
          connection.orgId.toString(),
          syncLog._id.toString(),
          'system:scheduler',
        );

        this.logger.log(
          `Queued incremental sync for connection ${connection._id} (provider: ${connection.provider})`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to queue sync for connection ${connection._id}: ${err.message}`,
        );
        // Continue with next connection — don't let one failure block others
      }
    }
  }
}
