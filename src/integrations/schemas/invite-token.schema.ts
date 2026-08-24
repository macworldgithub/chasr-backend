// src/integrations/schemas/invite-token.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'invitetokens' })
export class InviteToken extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Organisation', required: true })
  orgId: Types.ObjectId;

  /** 256-bit cryptographically secure random token (hex encoded) */
  @Prop({ required: true, unique: true })
  token: string;

  @Prop({ required: true, enum: ['xero', 'myob', 'csv'] })
  provider: string;

  @Prop({ required: true })
  createdByUserId: string;

  /** Optional — pre-fill invitee email on the connect page */
  @Prop()
  inviteeEmail: string;

  /** 7 days from creation — TTL index auto-deletes this doc afterwards */
  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ default: false })
  redeemed: boolean;

  @Prop()
  redeemedAt: Date;

  @Prop()
  redeemedByIp: string;

  /** Rate limiting — reject after 5 failed attempts */
  @Prop({ default: 0 })
  redemptionAttempts: number;
}

export const InviteTokenSchema = SchemaFactory.createForClass(InviteToken);

InviteTokenSchema.index({ token: 1 }, { unique: true });
// TTL auto-cleanup — MongoDB removes documents when expiresAt is reached
InviteTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Org-scoped listing for admin management view
InviteTokenSchema.index({ orgId: 1, createdAt: -1 });
