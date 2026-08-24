// src/sync/sync-orchestrator.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  AccountingConnection,
} from '../integrations/schemas/accounting-connection.schema';
import { SyncLog } from '../integrations/schemas/sync-log.schema';
import { SyncJobData } from './sync.types';

@Injectable()
export class SyncOrchestratorService {
  private readonly logger = new Logger(SyncOrchestratorService.name);

  constructor(
    @InjectQueue('accounting-sync')
    private readonly syncQueue: Queue<SyncJobData>,
    @InjectModel(AccountingConnection.name)
    private readonly connectionModel: Model<AccountingConnection>,
    @InjectModel(SyncLog.name)
    private readonly syncLogModel: Model<SyncLog>,
  ) {}

  /**
   * Dispatch a full sync job for a connection.
   * Creates a SyncLog document first, then queues the BullMQ job.
   * Returns the jobId for status polling.
   */
  async dispatchFullSync(
    connectionId: string,
    orgId: string,
    triggeredBy: string,
  ): Promise<{ jobId: string; syncLogId: string }> {
    const connection = await this.validateConnection(connectionId, orgId);

    const syncLog = await this.syncLogModel.create({
      connectionId: new Types.ObjectId(connectionId),
      orgId: new Types.ObjectId(orgId),
      triggerType: 'manual',
      status: 'started',
      actor: triggeredBy,
      startedAt: new Date(),
    });

    const job = await this.syncQueue.add(
      'full-sync',
      {
        type: 'full_sync',
        connectionId,
        orgId,
        triggeredBy,
        triggerType: 'manual',
        syncLogId: syncLog._id.toString(),
      },
      {
        jobId: `full-sync:${connectionId}:${Date.now()}`,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    );

    this.logger.log(
      `Dispatched full sync: jobId=${job.id}, connection=${connectionId}`,
    );

    return { jobId: job.id!, syncLogId: syncLog._id.toString() };
  }

  /**
   * Dispatch an incremental sync job.
   * Used by the scheduler — does not create a SyncLog (scheduler does that).
   */
  async dispatchIncrementalSync(
    connectionId: string,
    orgId: string,
    syncLogId: string,
    triggeredBy: string = 'scheduler',
  ): Promise<Job<SyncJobData>> {
    return this.syncQueue.add(
      'incremental-sync',
      {
        type: 'incremental_sync',
        connectionId,
        orgId,
        triggeredBy,
        triggerType: 'scheduled',
        syncLogId,
      },
    );
  }

  /**
   * Dispatch a CSV ingest job.
   */
  async dispatchCsvIngest(
    uploadId: string,
    mappings: Array<{ sourceColumn: string; targetField: string }>,
    orgId: string,
    triggeredBy: string,
    csvMeta: Record<string, any>,
  ): Promise<{ jobId: string; syncLogId: string }> {
    // CSV doesn't have a connectionId — use a placeholder
    const syncLog = await this.syncLogModel.create({
      orgId: new Types.ObjectId(orgId),
      connectionId: new Types.ObjectId(), // Synthetic ID for CSV
      triggerType: 'csv_upload',
      status: 'started',
      actor: triggeredBy,
      startedAt: new Date(),
      csvMeta,
    });

    const job = await this.syncQueue.add(
      'csv-ingest',
      {
        type: 'csv_ingest',
        connectionId: 'csv',
        orgId,
        triggeredBy,
        triggerType: 'csv_upload',
        csvUploadId: uploadId,
        csvMappings: mappings,
        syncLogId: syncLog._id.toString(),
      },
    );

    return { jobId: job.id!, syncLogId: syncLog._id.toString() };
  }

  /**
   * Get the status of a BullMQ job for frontend polling.
   */
  async getJobStatus(jobId: string): Promise<{
    status: 'waiting' | 'active' | 'completed' | 'failed' | 'unknown';
    progress: number;
    result?: any;
    failedReason?: string;
  }> {
    const job = await this.syncQueue.getJob(jobId);

    if (!job) {
      return { status: 'unknown', progress: 0 };
    }

    const state = await job.getState();
    const progress = typeof job.progress === 'number' ? job.progress : 0;

    return {
      status: state as any,
      progress,
      result: state === 'completed' ? job.returnvalue : undefined,
      failedReason: state === 'failed' ? job.failedReason : undefined,
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async validateConnection(
    connectionId: string,
    orgId: string,
  ): Promise<AccountingConnection> {
    const connection = await this.connectionModel.findOne({
      _id: new Types.ObjectId(connectionId),
      orgId: new Types.ObjectId(orgId),
      isDeleted: false,
    });

    if (!connection) {
      throw new NotFoundException(
        `Connection not found: ${connectionId}`,
      );
    }

    return connection;
  }
}
