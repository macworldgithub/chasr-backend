// src/integrations/schemas/accounting-connection.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ConnectionStatus =
  | 'connected'
  | 'syncing'
  | 'error'
  | 'disconnected'
  | 'pending_auth';

export type AuthMethod = 'oauth2' | 'api_key' | 'credential';

export type Provider = 'xero' | 'myob' | 'quickbooks' | 'csv';

@Schema({ timestamps: true, collection: 'accountingconnections' })
export class AccountingConnection extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Organisation', required: true, index: true })
  orgId: Types.ObjectId;

  @Prop({ required: true, enum: ['xero', 'myob', 'quickbooks', 'csv'] })
  provider: Provider;

  @Prop({ required: true, enum: ['oauth2', 'api_key', 'credential'] })
  authMethod: AuthMethod;

  /**
   * Encrypted credential bag. All token fields stored as AES-256-GCM ciphertext.
   * Decryption happens ONLY inside BullMQ workers via VaultService.
   * NEVER log or return these fields in API responses.
   */
  @Prop({
    type: {
      encryptedAccessToken: String,    // AES-256-GCM ciphertext
      encryptedRefreshToken: String,   // AES-256-GCM ciphertext
      tokenExpiresAt: Date,
      tenantId: String,                // Xero tenant/org ID
      tenantName: String,
      scopes: [String],
      // API key auth (MYOB desktop etc.)
      encryptedApiKey: String,
      encryptedApiSecret: String,
      // MYOB AccountRight company file URL
      companyFileUrl: String,
    },
    default: {},
  })
  credentials: Record<string, any>;

  @Prop({
    enum: ['connected', 'syncing', 'error', 'disconnected', 'pending_auth'],
    default: 'pending_auth',
  })
  status: ConnectionStatus;

  @Prop()
  lastSyncAt: Date;

  @Prop()
  lastSyncError: string;

  @Prop({ default: 0 }) totalInvoicesSynced: number;
  @Prop({ default: 0 }) totalContactsSynced: number;
  @Prop({ default: 0 }) totalPaymentsSynced: number;

  @Prop({
    type: {
      syncFrequencyMinutes: { type: Number, default: 30 },
      lookbackMonths: { type: Number, default: 18 },
      webhookEnabled: { type: Boolean, default: false },
      webhookSecret: String,
    },
    default: {},
  })
  settings: Record<string, any>;

  /** Xero webhook subscription ID (if webhooks enabled) */
  @Prop()
  webhookSubscriptionId: string;

  /** Soft delete — retains audit trail */
  @Prop({ default: false })
  isDeleted: boolean;

  @Prop()
  deletedAt: Date;
}

export const AccountingConnectionSchema = SchemaFactory.createForClass(AccountingConnection);

// One active connection per org per provider
AccountingConnectionSchema.index({ orgId: 1, provider: 1, isDeleted: 1 });
