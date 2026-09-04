// src/connectors/xero/xero-webhook.handler.ts
import {
  Controller,
  Post,
  Headers,
  Req,
  HttpCode,
  Logger,
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
 * XeroWebhookController — receives push notifications from Xero.
 *
 * Critical rules:
 * 1. Must respond 200 within 5 seconds (Xero will retry then deactivate)
 * 2. Validate HMAC-SHA256 signature before processing
 * 3. All processing happens async in BullMQ — never block the response
 * 4. Return 401 for invalid signatures (Xero's Intent-To-Receive validation)
 */
@Controller('webhooks')
export class XeroWebhookHandler {
  private readonly logger = new Logger(XeroWebhookHandler.name);

  constructor(
    @InjectModel(AccountingConnection.name)
    private readonly connectionModel: Model<AccountingConnection>,
    @InjectModel(SyncLog.name)
    private readonly syncLogModel: Model<SyncLog>,
    @InjectQueue('accounting-sync')
    private readonly syncQueue: Queue<SyncJobData>,
  ) {}

  @Post('xero')
  @HttpCode(200)
  async handleXeroWebhook(
    @Headers('x-xero-signature') signature: string,
    @Req() req: Request & { rawBody?: Buffer },
  ): Promise<{ status: number }> {
    const rawBody = req.rawBody;

    if (!rawBody) {
      this.logger.error(
        'rawBody is undefined — ensure bodyParser is configured with { verify } to capture raw body',
      );
      return { status: 200 }; // Still 200 so Xero doesn't deactivate the endpoint
    }

    // Validate HMAC-SHA256 signature
    const secret = process.env.XERO_WEBHOOK_SIGNING_SECRET!;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    if (!this.timingSafeCompare(signature ?? '', expectedSig)) {
      this.logger.warn('Invalid Xero webhook signature — returning 401');
      // Xero's Intent-To-Receive validation expects 401 for invalid sigs
      return { status: 401 };
    }

    const body = JSON.parse(rawBody.toString('utf8')) as {
      events: Array<{
        resourceType: string;
        resourceId: string;
        eventType: string;
        tenantId: string;
        tenantType: string;
      }>;
    };

    // Queue each event independently — O(n) jobs where n = events in batch
    // Recognised resource types: INVOICE, CONTACT, PAYMENT, CREDITNOTE
    for (const event of body.events ?? []) {
      const connection = await this.connectionModel.findOne({
        'credentials.tenantId': event.tenantId,
        provider: 'xero',
        isDeleted: false,
        status: { $in: ['connected', 'syncing'] },
      });

      if (!connection) {
        this.logger.warn(
          `No active connection found for Xero tenant ${event.tenantId}`,
        );
        continue;
      }

      const syncLog = await this.syncLogModel.create({
        connectionId: connection._id,
        orgId: connection.orgId,
        triggerType: 'webhook',
        status: 'started',
        actor: 'system:webhook',
        startedAt: new Date(),
      });

      await this.syncQueue.add(
        'webhook-event',
        {
          type: 'webhook_event',
          connectionId: connection._id.toString(),
          orgId: connection.orgId.toString(),
          triggeredBy: 'system:webhook',
          triggerType: 'webhook',
          webhookPayload: event,
          syncLogId: syncLog._id.toString(),
        },
        { priority: 1 }, // High priority — webhook events are user-initiated changes
      );

      this.logger.log(
        `Queued webhook event ${event.resourceType}:${event.resourceId} for org ${connection.orgId}`,
      );
    }

    return { status: 200 };
  }

  /** Timing-safe string comparison to prevent timing attacks */
  private timingSafeCompare(a: string, b: string): boolean {
    try {
      return crypto.timingSafeEqual(Buffer.from(a, 'base64'), Buffer.from(b, 'base64'));
    } catch {
      return false;
    }
  }
}
