// src/sync/sync.processor.ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Job } from 'bullmq';
import {
  AccountingConnection,
} from '../integrations/schemas/accounting-connection.schema';
import { SyncLog } from '../integrations/schemas/sync-log.schema';
import { ConnectorFactory } from '../connectors/connector.factory';
import { CsvConnector } from '../connectors/csv/csv.connector';
import { AuditLoggerService } from '../audit/audit-logger.service';
import { SyncJobData } from './sync.types';
import { SyncResult } from '../connectors/base.connector';

/**
 * SyncProcessor — BullMQ worker that processes all accounting sync jobs.
 *
 * Handles:
 *   - full_sync      : Initial or manual full historical sync
 *   - incremental_sync: Scheduler-triggered delta sync
 *   - webhook_event  : Single-resource update from Xero webhook
 *   - csv_ingest     : CSV file data ingestion
 *
 * On failure: throws error → BullMQ handles exponential backoff retries.
 */
@Processor('accounting-sync', {
  concurrency: 5, // Process up to 5 jobs in parallel
})
export class SyncProcessor extends WorkerHost {
  private readonly logger = new Logger(SyncProcessor.name);

  constructor(
    @InjectModel(AccountingConnection.name)
    private readonly connectionModel: Model<AccountingConnection>,
    @InjectModel(SyncLog.name)
    private readonly syncLogModel: Model<SyncLog>,
    private readonly connectorFactory: ConnectorFactory,
    private readonly csvConnector: CsvConnector,
    private readonly auditLogger: AuditLoggerService,
  ) {
    super();
  }

  async process(job: Job<SyncJobData>): Promise<SyncResult> {
    const { type, connectionId, orgId, syncLogId } = job.data;

    this.logger.log(
      `Processing job ${job.id}: type=${type}, connection=${connectionId}`,
    );

    // Load connection (credentials are decrypted ONLY inside this worker)
    const connection =
      connectionId !== 'csv'
        ? await this.connectionModel.findById(connectionId)
        : null;

    if (connectionId !== 'csv' && (!connection || connection.isDeleted)) {
      this.logger.warn(`Connection ${connectionId} not found or deleted — skipping job`);
      return this.emptyResult();
    }

    // Mark connection as syncing
    if (connection) {
      await this.connectionModel.updateOne(
        { _id: connectionId },
        { status: 'syncing' },
      );
    }

    await this.syncLogModel.updateOne(
      { _id: syncLogId },
      { status: 'started', startedAt: new Date() },
    );

    const startTime = Date.now();
    let result: SyncResult;

    try {
      result = await this.dispatchJob(job, connection);

      const durationMs = Date.now() - startTime;
      const status = result.errors.length > 0 ? 'partial' : 'completed';

      // Update SyncLog
      await this.syncLogModel.updateOne({ _id: syncLogId }, {
        status,
        completedAt: new Date(),
        durationMs,
        contactsUpserted: result.contactsUpserted,
        invoicesUpserted: result.invoicesUpserted,
        paymentsUpserted: result.paymentsUpserted,
        recordsSkipped: result.recordsSkipped,
        recordsFailed: result.recordsFailed,
        syncErrors: result.errors,
      });

      // Update connection
      if (connection) {
        await this.connectionModel.updateOne({ _id: connectionId }, {
          status: 'connected',
          lastSyncAt: new Date(),
          lastSyncError: null,
          $inc: {
            totalInvoicesSynced: result.invoicesUpserted,
            totalContactsSynced: result.contactsUpserted,
            totalPaymentsSynced: result.paymentsUpserted,
          },
        });
      }

      // Audit
      await this.auditLogger.log({
        orgId: connection?.orgId ?? job.data as any,
        actor: job.data.triggeredBy,
        event: 'sync.completed',
        outcome: result.errors.length > 0 ? 'partial' : 'success',
        metadata: {
          connectionId,
          provider: connection?.provider,
          ...result,
          durationMs,
        },
      });

      this.logger.log(
        `Job ${job.id} completed: invoices=${result.invoicesUpserted}, contacts=${result.contactsUpserted}, payments=${result.paymentsUpserted}`,
      );

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      await this.syncLogModel.updateOne({ _id: syncLogId }, {
        status: 'failed',
        completedAt: new Date(),
        durationMs,
        syncErrors: [error.message],
      });

      if (connection) {
        await this.connectionModel.updateOne({ _id: connectionId }, {
          status: 'error',
          lastSyncError: error.message,
        });
      }

      await this.auditLogger.log({
        orgId: connection?.orgId as any,
        actor: job.data.triggeredBy,
        event: 'sync.failed',
        outcome: 'failure',
        metadata: {
          connectionId,
          provider: connection?.provider,
          error: error.message,
          jobId: job.id,
        },
      });

      this.logger.error(`Job ${job.id} failed: ${error.message}`, error.stack);
      throw error; // Re-throw so BullMQ handles retry with exponential backoff
    }
  }

  private async dispatchJob(
    job: Job<SyncJobData>,
    connection: AccountingConnection | null,
  ): Promise<SyncResult> {
    const { type } = job.data;

    switch (type) {
      case 'full_sync':
        return this.connectorFactory
          .getConnector(connection!.provider)
          .fullSync(connection!);

      case 'incremental_sync':
        return this.connectorFactory
          .getConnector(connection!.provider)
          .incrementalSync(connection!);

      case 'webhook_event':
        return this.connectorFactory
          .getConnector(connection!.provider)
          .processWebhookEvent(connection!, job.data.webhookPayload);

      case 'csv_ingest':
        return this.csvConnector.commitUpload(
          job.data.csvUploadId!,
          job.data.csvMappings ?? [],
        );

      default:
        throw new Error(`Unknown job type: ${type}`);
    }
  }

  private emptyResult(): SyncResult {
    return {
      contactsUpserted: 0,
      invoicesUpserted: 0,
      paymentsUpserted: 0,
      recordsSkipped: 0,
      recordsFailed: 0,
      errors: [],
    };
  }
}
