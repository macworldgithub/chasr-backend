// src/integrations/schemas/xero-organisation.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * XeroOrganisation — stores the synced Xero org details for a connection.
 *
 * This is fetched once on fullSync (via getOrganisations()) and kept up-to-date
 * on incremental sync. Used by the UI to show org name, currency, etc.
 *
 * One document per AccountingConnection (1:1 relationship).
 */
@Schema({ timestamps: true, collection: 'xeroorganisations' })
export class XeroOrganisation extends Document {
  /** The AccountingConnection this org belongs to */
  @Prop({ type: Types.ObjectId, ref: 'AccountingConnection', required: true, index: true })
  connectionId: Types.ObjectId;

  /** The Chasr org this belongs to */
  @Prop({ type: Types.ObjectId, ref: 'Organisation', required: true, index: true })
  orgId: Types.ObjectId;

  // ── Fields synced from Xero's GET /Organisations ──────────────────────────

  @Prop() name: string;              // Legal/display name e.g. "Acme Pty Ltd"
  @Prop() legalName: string;         // Legal entity name
  @Prop() taxNumber: string;         // ABN or equivalent

  @Prop() baseCurrency: string;      // e.g. "AUD"
  @Prop() countryCode: string;       // e.g. "AU"
  @Prop() timezone: string;          // e.g. "SYDNEY"

  @Prop() shortCode: string;         // Xero's short code (used in Xero URLs)
  @Prop() xeroOrgId: string;         // Xero's internal organisation ID

  /** Which Xero edition: BUSINESS, PARTNER, ACCOUNTING_PRACTICE, etc. */
  @Prop() organisationType: string;

  /** Financial year end month (1-12) */
  @Prop() financialYearEndMonth: number;

  /** Last time this was fetched from Xero */
  @Prop() lastSyncedAt: Date;
}

export const XeroOrganisationSchema =
  SchemaFactory.createForClass(XeroOrganisation);

// One org per connection
XeroOrganisationSchema.index({ connectionId: 1 }, { unique: true });
