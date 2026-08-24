// src/integrations/schemas/contact.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'contacts' })
export class Contact extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Organisation', required: true, index: true })
  orgId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ type: [String], default: [] })
  emails: string[];

  @Prop({ type: [String], default: [] })
  phones: string[];

  @Prop({
    type: {
      street: String,
      city: String,
      state: String,
      postcode: String,
      country: String,
    },
  })
  address: Record<string, string>;

  /** Net payment terms in days (e.g. 30 for NET30) */
  @Prop({ type: Number })
  paymentTermsDays: number;

  // ── Integration fields ─────────────────────────────────────────────────
  @Prop({ index: true })
  externalId: string;

  @Prop({ index: true })
  externalSource: string; // 'xero' | 'myob' | 'csv'

  @Prop({ type: Types.ObjectId, ref: 'AccountingConnection' })
  externalConnectionId: Types.ObjectId;

  @Prop()
  lastSyncedAt: Date;

  // ── Chasr-owned fields ─────────────────────────────────────────────────
  @Prop({ default: 'active' })
  chaseState: string;
}

export const ContactSchema = SchemaFactory.createForClass(Contact);

ContactSchema.index(
  { orgId: 1, externalId: 1, externalSource: 1 },
  { unique: true, sparse: true, name: 'idx_contact_external' },
);
ContactSchema.index({ orgId: 1, name: 1 });
