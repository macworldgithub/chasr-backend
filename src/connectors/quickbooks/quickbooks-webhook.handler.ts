// src/connectors/quickbooks/quickbooks-webhook.handler.ts
import {
  Controller,
  Post,
  Headers,
  Req,
  HttpCode,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as crypto from 'crypto';
import { Request } from 'express';
import { AccountingConnection } from '../../integrations/schemas/accounting-connection.schema';
import { SyncLog } from '../../integrations/schemas/sync-log.schema';
import { SyncJobData } from '../../sync/sync.types';

/**
 * QuickBooksWebhookHandler — receives real-time push event notifications from QuickBooks Online (APIs #16 & #17).
 *
 * Rules:
 * 1. Must respond with HTTP 200 within 5 seconds to prevent QuickBooks retry/deactivation.
 * 2. Validates `intuit-signature` using HMAC-SHA256 with `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN`.
 * 3. Enqueues event processing asynchronously into BullMQ `accounting-sync` queue with priority 1.
 */
@Controller('webhooks')
export class QuickBooksWebhookHandler {
  private readonly logger = new Logger(QuickBooksWebhookHandler.name);

  constructor(
    @InjectModel(AccountingConnection.name)
    private readonly connectionModel: Model<AccountingConnection>,
    @InjectModel(SyncLog.name)
    private readonly syncLogModel: Model<SyncLog>,
    @InjectQueue('accounting-sync')
    private readonly syncQueue: Queue<SyncJobData>,
  ) {}

  @Post('quickbooks')
  @HttpCode(200)
  async handleQuickBooksWebhook(
    @Headers('intuit-signature') signature: string,
    @Req() req: Request & { rawBody?: Buffer },
  ): Promise<{ status: number }> {
    const rawBody = req.rawBody || (typeof req.body === 'string' ? Buffer.from(req.body) : Buffer.from(JSON.stringify(req.body || {})));

    // Validate intuit-signature
    const verifierToken =
      process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN ||
      process.env.QUICKBOOKS_WEBHOOK_SECRET;

    if (verifierToken && signature) {
      const expectedSig = crypto
        .createHmac('sha256', verifierToken)
        .update(rawBody)
        .digest('base64');

      if (!this.timingSafeCompare(signature, expectedSig)) {
        this.logger.warn(
          'Invalid QuickBooks webhook signature — returning 401 Unauthorized',
        );
        throw new UnauthorizedException('Invalid QuickBooks webhook signature');
      }
    }

    const payload = (req.rawBody
      ? JSON.parse(req.rawBody.toString('utf8'))
      : req.body) as {
      eventNotifications?: Array<{
        realmId: string;
        dataChangeEvent?: {
          entities?: Array<{
            name: string;
            id: string;
            operation: string;
            lastUpdated: string;
          }>;
        };
      }>;
    };

    const notifications = payload?.eventNotifications ?? [];

    for (const notification of notifications) {
      const realmId = notification.realmId;
      const entities = notification.dataChangeEvent?.entities ?? [];

      const connection = await this.connectionModel.findOne({
        $or: [
          { 'credentials.realmId': realmId },
          { 'credentials.tenantId': realmId },
        ],
        provider: 'quickbooks',
        isDeleted: false,
        status: { $in: ['connected', 'syncing'] },
      });

      if (!connection) {
        this.logger.warn(
          `No active connection found for QuickBooks realmId ${realmId}`,
        );
        continue;
      }

      for (const entity of entities) {
        const syncLog = await this.syncLogModel.create({
          connectionId: connection._id,
          orgId: connection.orgId,
          triggerType: 'webhook',
          status: 'started',
          actor: 'system:quickbooks-webhook',
          startedAt: new Date(),
        });

        await this.syncQueue.add(
          'webhook-event',
          {
            type: 'webhook_event',
            connectionId: connection._id.toString(),
            orgId: connection.orgId.toString(),
            triggeredBy: 'system:quickbooks-webhook',
            triggerType: 'webhook',
            webhookPayload: {
              entityName: entity.name,
              entityId: entity.id,
              operation: entity.operation,
              lastUpdated: entity.lastUpdated,
              realmId,
            },
            syncLogId: syncLog._id.toString(),
          },
          { priority: 1 },
        );

        this.logger.log(
          `Queued QuickBooks webhook event ${entity.name}:${entity.id} (${entity.operation}) for org ${connection.orgId}`,
        );
      }
    }

    return { status: 200 };
  }

  private timingSafeCompare(a: string, b: string): boolean {
    try {
      const bufA = Buffer.from(a, 'base64');
      const bufB = Buffer.from(b, 'base64');
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }
}
