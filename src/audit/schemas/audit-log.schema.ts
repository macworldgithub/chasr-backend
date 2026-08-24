// src/audit/schemas/audit-log.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AuditEventType =
  | 'connection.created'
  | 'connection.revoked'
  | 'connection.reauthorised'
  | 'sync.started'
  | 'sync.completed'
  | 'sync.failed'
  | 'credential.accessed'
  | 'invite.created'
  | 'invite.redeemed'
  | 'invite.expired'
  | 'data.mutation';

@Schema({
  timestamps: true,
  // Immutable collection — no updates, only inserts
  collection: 'auditlogs',
})
export class AuditLog extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Organisation', index: true })
  orgId: Types.ObjectId;

  /** userId or 'system:{jobId}' or 'invite:{token_prefix}' */
  @Prop({ required: true })
  actor: string;

  @Prop()
  ip: string;

  @Prop({
    enum: [
      'connection.created',
      'connection.revoked',
      'connection.reauthorised',
      'sync.started',
      'sync.completed',
      'sync.failed',
      'credential.accessed',
      'invite.created',
      'invite.redeemed',
      'invite.expired',
      'data.mutation',
    ],
    required: true,
  })
  event: AuditEventType;

  /** Contextual metadata — connectionId, provider, recordCounts, etc. */
  @Prop({ type: Object })
  metadata: Record<string, any>;

  @Prop({ enum: ['success', 'failure', 'partial'], required: true })
  outcome: string;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);

// Compound index for org-scoped time-range queries
AuditLogSchema.index({ orgId: 1, createdAt: -1 });
// Event-type index for filtering
AuditLogSchema.index({ event: 1, createdAt: -1 });
