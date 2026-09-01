// src/audit/audit-logger.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { normalizeOrgId } from '../shared/utils/org-id.util';
import { AuditLog, AuditEventType } from './schemas/audit-log.schema';

export interface AuditLogEntry {
  orgId: Types.ObjectId | string;
  actor: string;
  ip?: string;
  event: AuditEventType;
  outcome: 'success' | 'failure' | 'partial';
  metadata?: Record<string, any>;
}

/**
 * AuditLoggerService — append-only audit trail.
 *
 * RULE: Never call update/delete on the auditlogs collection.
 * Every call to `log()` creates a new document.
 */
@Injectable()
export class AuditLoggerService {
  private readonly logger = new Logger(AuditLoggerService.name);

  constructor(
    @InjectModel(AuditLog.name)
    private readonly auditLogModel: Model<AuditLog>,
  ) {}

  async log(entry: AuditLogEntry): Promise<void> {
    const normalizedOrgId = normalizeOrgId(String(entry.orgId));

    // Append-only — always create, never update
    await this.auditLogModel.create({
      orgId: normalizedOrgId,
      actor: entry.actor,
      ip: entry.ip,
      event: entry.event,
      outcome: entry.outcome,
      metadata: entry.metadata,
    });

    // Surface critical events to application logs
    const criticalEvents: AuditEventType[] = [
      'connection.revoked',
      'sync.failed',
      'credential.accessed',
    ];

    if (criticalEvents.includes(entry.event)) {
      this.logger.warn(
        `[AUDIT] ${entry.event} | actor=${entry.actor} | outcome=${entry.outcome}`,
        entry.metadata,
      );
    }
  }
}
