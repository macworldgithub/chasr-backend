// src/integrations/schemas/sync-log.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'synclogs' })
export class SyncLog extends Document {
  @Prop({ type: Types.ObjectId, ref: 'AccountingConnection', required: true, index: true })
  connectionId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Organisation', required: true, index: true })
  orgId: Types.ObjectId;

  @Prop({
    enum: ['manual', 'scheduled', 'webhook', 'csv_upload'],
    required: true,
  })
  triggerType: string;

  @Prop({
    enum: ['started', 'completed', 'failed', 'partial'],
    default: 'started',
  })
  status: string;

  @Prop()
  startedAt: Date;

  @Prop()
  completedAt: Date;

  @Prop({ type: Number })
  durationMs: number;

  @Prop({ default: 0 }) contactsUpserted: number;
  @Prop({ default: 0 }) invoicesUpserted: number;
  @Prop({ default: 0 }) paymentsUpserted: number;
  @Prop({ default: 0 }) recordsSkipped: number;
  @Prop({ default: 0 }) recordsFailed: number;

  @Prop({ type: [String], default: [] })
  syncErrors: string[];

  /** userId or 'system' or 'system:webhook' */
  @Prop({ required: true })
  actor: string;

  @Prop()
  ipAddress: string;

  /** For CSV uploads: original filename, row count, mapping template used */
  @Prop({ type: Object })
  csvMeta: Record<string, any>;
}

export const SyncLogSchema: import('mongoose').Schema = SchemaFactory.createForClass(SyncLog);
SyncLogSchema.index({ connectionId: 1, createdAt: -1 });
SyncLogSchema.index({ orgId: 1, createdAt: -1 });
