// src/integrations/schemas/payment.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'payments' })
export class Payment extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Organisation', required: true, index: true })
  orgId: Types.ObjectId;

  @Prop({ required: true })
  date: Date;

  @Prop({ type: Number, required: true })
  amount: number;

  @Prop({ default: 'AUD' })
  currency: string;

  /** Payment method: 'BANK', 'CASH', 'CREDIT_CARD', etc. */
  @Prop()
  method: string;

  @Prop()
  reference: string;

  /** Invoice(s) this payment was allocated to (Chasr internal IDs) */
  @Prop({ type: [Types.ObjectId], ref: 'Invoice', default: [] })
  allocatedInvoiceIds: Types.ObjectId[];

  // ── Integration fields ─────────────────────────────────────────────────
  @Prop({ index: true })
  externalId: string;

  @Prop({ index: true })
  externalSource: string; // 'xero' | 'myob' | 'csv'

  @Prop({ type: Types.ObjectId, ref: 'AccountingConnection' })
  externalConnectionId: Types.ObjectId;

  @Prop()
  lastSyncedAt: Date;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);

PaymentSchema.index(
  { orgId: 1, externalId: 1, externalSource: 1 },
  { unique: true, sparse: true, name: 'idx_payment_external' },
);
PaymentSchema.index({ orgId: 1, date: -1 });
