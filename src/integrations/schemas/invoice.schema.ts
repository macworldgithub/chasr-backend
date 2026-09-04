// src/integrations/schemas/invoice.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type InvoiceStatus =
  | 'DRAFT'
  | 'AUTHORISED'
  | 'PAID'
  | 'VOIDED'
  | 'OVERDUE';

export type ChaseState =
  | 'pending'   // Not yet evaluated
  | 'active'    // Currently in a chase sequence
  | 'paused'    // Manually paused
  | 'complete'  // Invoice paid, chase halted
  | 'excluded'; // Excluded from chasing

@Schema({ timestamps: true, collection: 'invoices' })
export class Invoice extends Document {
  // ── Ownership ─────────────────────────────────────────────────────────
  @Prop({ type: Types.ObjectId, ref: 'Organisation', required: true, index: true })
  orgId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Contact' })
  contactId: Types.ObjectId;

  // ── Core invoice fields ───────────────────────────────────────────────
  @Prop({ required: true })
  invoiceNumber: string;

  @Prop({ enum: ['ACCREC', 'ACCPAY'], default: 'ACCREC' })
  invoiceType: 'ACCREC' | 'ACCPAY';

  @Prop()
  creditNoteNumber: string;

  @Prop({ type: [String], default: [] })
  linkedInvoiceIds: string[];

  @Prop()
  issueDate: Date;

  @Prop({ required: true })
  dueDate: Date;

  @Prop({ type: Number, required: true })
  total: number;

  @Prop({ type: Number, required: true })
  balanceDue: number;

  @Prop({ default: 'AUD' })
  currency: string;

  @Prop({
    enum: ['DRAFT', 'AUTHORISED', 'PAID', 'VOIDED', 'OVERDUE'],
    default: 'AUTHORISED',
  })
  status: InvoiceStatus;

  @Prop()
  pdfUrl: string;

  // ── Integration fields (set by sync pipeline) ─────────────────────────
  @Prop({ index: true })
  externalId: string;

  @Prop({ index: true })
  externalSource: string; // 'xero' | 'myob' | 'csv'

  @Prop({ type: Types.ObjectId, ref: 'AccountingConnection' })
  externalConnectionId: Types.ObjectId;

  @Prop()
  lastSyncedAt: Date;

  // ── Chasr-owned chase fields (NEVER overwritten by sync pipeline) ─────
  @Prop({
    enum: ['pending', 'active', 'paused', 'complete', 'excluded'],
    default: 'pending',
  })
  chaseState: ChaseState;

  @Prop()
  lastChaseAt: Date;

  @Prop({ type: Types.ObjectId, ref: 'ChaseSequence' })
  chaseSequenceId: Types.ObjectId;
}

export const InvoiceSchema = SchemaFactory.createForClass(Invoice);

// Critical: idempotent upsert key (sparse so nulls don't violate uniqueness)
InvoiceSchema.index(
  { orgId: 1, externalId: 1, externalSource: 1 },
  { unique: true, sparse: true, name: 'idx_invoice_external' },
);
InvoiceSchema.index({ orgId: 1, dueDate: 1 });
InvoiceSchema.index({ orgId: 1, status: 1 });
InvoiceSchema.index({ orgId: 1, chaseState: 1 });
