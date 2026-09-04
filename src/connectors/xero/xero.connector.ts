// src/connectors/xero/xero.connector.ts
import { Injectable, Logger } from '@nestjs/common';
import { XeroClient } from 'xero-node';
import { BaseConnector, SyncResult } from '../base.connector';
import { VaultService } from '../../credential-vault/vault.service';
import { DataMapperService } from '../../sync/data-mapper.service';
import { XeroOAuthService } from './xero-oauth.service';
import { AccountingConnection } from '../../integrations/schemas/accounting-connection.schema';
import { withRateLimit } from './xero-rate-limiter';

const PAGE_SIZE = 100;

@Injectable()
export class XeroConnector extends BaseConnector {
  private readonly logger = new Logger(XeroConnector.name);

  constructor(
    private readonly vault: VaultService,
    private readonly dataMapper: DataMapperService,
    private readonly xeroOAuth: XeroOAuthService,
  ) {
    super();
  }

  // ── Public interface ──────────────────────────────────────────────────

  async fullSync(connection: AccountingConnection): Promise<SyncResult> {
    const xero = await this.buildAuthenticatedClient(connection);
    const tenantId = connection.credentials.tenantId as string;
    const result = this.emptyResult();

    // Fetch and store Xero organisation info (name, currency, country, etc.)
    await this.syncOrganisation(xero, tenantId, connection);

    await this.syncContacts(xero, tenantId, connection, result, null);
    await this.syncInvoices(xero, tenantId, connection, result, null);
    await this.syncCreditNotes(xero, tenantId, connection, result, null);
    await this.syncPayments(xero, tenantId, connection, result, null);

    return result;
  }

  async incrementalSync(connection: AccountingConnection): Promise<SyncResult> {
    const xero = await this.buildAuthenticatedClient(connection);
    const tenantId = connection.credentials.tenantId as string;
    const result = this.emptyResult();

    // Xero uses If-Modified-Since header for incremental fetching
    const since = connection.lastSyncAt ?? null;

    await this.syncContacts(xero, tenantId, connection, result, since);
    await this.syncInvoices(xero, tenantId, connection, result, since);
    await this.syncCreditNotes(xero, tenantId, connection, result, since);
    await this.syncPayments(xero, tenantId, connection, result, since);

    return result;
  }

  async processWebhookEvent(
    connection: AccountingConnection,
    webhookPayload: any,
  ): Promise<SyncResult> {
    const xero = await this.buildAuthenticatedClient(connection);
    const tenantId = connection.credentials.tenantId as string;
    const result = this.emptyResult();

    const { resourceType, resourceId } = webhookPayload as {
      resourceType: string;
      resourceId: string;
    };

    switch (resourceType) {
      case 'INVOICE': {
        const resp = await withRateLimit(() =>
          xero.accountingApi.getInvoice(tenantId, resourceId),
        );
        const invoice = resp.body.invoices?.[0];
        if (invoice) {
          await this.dataMapper.upsertInvoice(
            connection.orgId,
            'xero',
            invoice,
          );
          result.invoicesUpserted++;
        }
        break;
      }
      case 'CONTACT': {
        const resp = await withRateLimit(() =>
          xero.accountingApi.getContact(tenantId, resourceId),
        );
        const contact = resp.body.contacts?.[0];
        if (contact) {
          await this.dataMapper.upsertContact(
            connection.orgId,
            'xero',
            contact,
          );
          result.contactsUpserted++;
        }
        break;
      }
      case 'PAYMENT': {
        const resp = await withRateLimit(() =>
          xero.accountingApi.getPayment(tenantId, resourceId),
        );
        const payment = resp.body.payments?.[0];
        if (payment) {
          await this.dataMapper.upsertPayment(
            connection.orgId,
            'xero',
            payment,
          );
          result.paymentsUpserted++;
        }
        break;
      }
      case 'CREDITNOTE': {
        const resp = await withRateLimit(() =>
          xero.accountingApi.getCreditNote(tenantId, resourceId),
        );
        const creditNote = resp.body.creditNotes?.[0];
        if (creditNote) {
          await this.dataMapper.upsertCreditNote(connection.orgId, 'xero', creditNote);
          result.invoicesUpserted++;
        }
        break;
      }
      default:
        this.logger.warn(`Unknown Xero webhook resourceType: ${resourceType}`);
        result.recordsSkipped++;
    }

    return result;
  }

  async refreshTokensIfNeeded(
    connection: AccountingConnection,
  ): Promise<AccountingConnection> {
    const expiresAt = connection.credentials.tokenExpiresAt as Date;
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

    if (expiresAt <= fiveMinutesFromNow) {
      this.logger.log(
        `Refreshing Xero token for connection ${connection._id} (expires ${expiresAt.toISOString()})`,
      );
      return this.xeroOAuth.refreshAccessToken(connection);
    }

    return connection;
  }

  async validateConnection(connection: AccountingConnection): Promise<boolean> {
    try {
      const xero = await this.buildAuthenticatedClient(connection);
      await withRateLimit(() =>
        xero.accountingApi.getOrganisations(
          connection.credentials.tenantId as string,
        ),
      );
      return true;
    } catch {
      return false;
    }
  }

  async revokeAccess(connection: AccountingConnection): Promise<void> {
    await this.xeroOAuth.revokeTokens(connection);
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private async buildAuthenticatedClient(
    connection: AccountingConnection,
  ): Promise<XeroClient> {
    const refreshed = await this.refreshTokensIfNeeded(connection);
    const rawEncryptedToken =
      refreshed.credentials?.encryptedAccessToken ??
      refreshed.credentials?.encrypted_accessToken ??
      refreshed.credentials?.encrypted_access_token;

    if (!rawEncryptedToken) {
      throw new Error(
        `Xero connection ${connection._id} is missing encryptedAccessToken in credentials bag`,
      );
    }

    const accessToken = this.vault.decrypt(rawEncryptedToken);

    // ⚠️ Scopes here MUST match what was requested during OAuth.
    // The token was issued with all of these — a mismatch causes SDK validation issues.
    const xero = new XeroClient({
      clientId: process.env.XERO_CLIENT_ID!,
      clientSecret: process.env.XERO_CLIENT_SECRET!,
      redirectUris: [process.env.XERO_REDIRECT_URI!],
   scopes: [
  'openid',
  'profile',
  'email',
  'accounting.invoices',
  'accounting.payments',
  'accounting.contacts',
  'accounting.settings',
  'offline_access',
],
    });

    // Inject token set directly — skips the OAuth dance
    xero.setTokenSet({
      access_token: accessToken,
      token_type: 'Bearer',
    });

    await xero.updateTenants();
    return xero;
  }

  /** Sync all contacts, optionally filtered by modifiedAfter */
  private async syncContacts(
    xero: XeroClient,
    tenantId: string,
    connection: AccountingConnection,
    result: SyncResult,
    modifiedAfter: Date | null,
  ): Promise<void> {
    let page = 1;
    const since = modifiedAfter ?? undefined;

    while (true) {
      const resp = await withRateLimit(() =>
        xero.accountingApi.getContacts(
          tenantId,
          since,        // ifModifiedSince
          undefined,    // where
          undefined,    // order
          undefined,    // ids
          page,         // page
          undefined,    // includeArchived
          undefined,    // summaryOnly
          undefined,    // searchTerm
        ),
      );

      const contacts = resp.body.contacts ?? [];
      if (contacts.length === 0) break;

      for (const contact of contacts) {
        try {
          await this.dataMapper.upsertContact(
            connection.orgId,
            'xero',
            contact,
          );
          result.contactsUpserted++;
        } catch (err) {
          result.errors.push(`Contact ${contact.contactID}: ${err.message}`);
          result.recordsFailed++;
        }
      }

      if (contacts.length < PAGE_SIZE) break;
      page++;
    }
  }

  /** Sync invoices within lookback window, optionally filtered by modifiedAfter */
  private async syncInvoices(
    xero: XeroClient,
    tenantId: string,
    connection: AccountingConnection,
    result: SyncResult,
    modifiedAfter: Date | null,
  ): Promise<void> {
    const lookbackMonths =
      (connection.settings?.lookbackMonths as number) ?? 18;
    const lookbackDate = new Date();
    lookbackDate.setMonth(lookbackDate.getMonth() - lookbackMonths);

    const since = modifiedAfter ?? undefined;
    let page = 1;

    while (true) {
      const resp = await withRateLimit(() =>
        xero.accountingApi.getInvoices(
          tenantId,
          since,        // ifModifiedSince
          undefined,    // where
          undefined,    // order
          undefined,    // ids
          undefined,    // invoiceNumbers
          undefined,    // contactIDs
          ['AUTHORISED', 'PAID', 'VOIDED'] as any,
          undefined,    // createdByMyApp
          undefined,    // unitdp
          undefined,    // summaryOnly
          page,
        ),
      );

      const invoices = resp.body.invoices ?? [];
      if (invoices.length === 0) break;

      for (const invoice of invoices) {
        // Skip invoices outside our lookback window (Xero doesn't filter by dueDate via API)
        const dueDate = invoice.dueDate ? new Date(invoice.dueDate) : null;
        if (dueDate && dueDate < lookbackDate) {
          result.recordsSkipped++;
          continue;
        }

        try {
          await this.dataMapper.upsertInvoice(
            connection.orgId,
            'xero',
            invoice,
          );
          result.invoicesUpserted++;
        } catch (err) {
     
          result.errors.push(`Invoice ${invoice.invoiceID}: ${err.message}`);
          result.recordsFailed++;
        }
      }

      if (invoices.length < PAGE_SIZE) break;
      page++;
    }
  }

  /** Sync credit notes, optionally filtered by modifiedAfter */
  private async syncCreditNotes(
    xero: XeroClient,
    tenantId: string,
    connection: AccountingConnection,
    result: SyncResult,
    modifiedAfter: Date | null,
  ): Promise<void> {
    const since = modifiedAfter ?? undefined;
    let page = 1;

    while (true) {
      const resp = await withRateLimit(() =>
        xero.accountingApi.getCreditNotes(
          tenantId,
          since,      // ifModifiedSince
          undefined,  // where
          undefined,  // order
          page,       // page
        ),
      );

      const creditNotes = resp.body.creditNotes ?? [];
      if (creditNotes.length === 0) break;

      for (const creditNote of creditNotes) {
        try {
          await this.dataMapper.upsertCreditNote(connection.orgId, 'xero', creditNote);
          result.invoicesUpserted++;
        } catch (err) {
          result.errors.push(`CreditNote ${creditNote.creditNoteID}: ${err.message}`);
          result.recordsFailed++;
        }
      }

      if (creditNotes.length < PAGE_SIZE) break;
      page++;
    }
  }

  /** Sync payments, optionally filtered by modifiedAfter — paginated (100 per page) */
  private async syncPayments(
    xero: XeroClient,
    tenantId: string,
    connection: AccountingConnection,
    result: SyncResult,
    modifiedAfter: Date | null,
  ): Promise<void> {
    const since = modifiedAfter ?? undefined;
    let page = 1;

    while (true) {
      const resp = await withRateLimit(() =>
        xero.accountingApi.getPayments(
          tenantId,
          since,      // ifModifiedSince
          undefined,  // where
          undefined,  // order
          undefined,  // paymentIDs
          page,       // page (100 per page)
        ),
      );

      const payments = resp.body.payments ?? [];
      if (payments.length === 0) break;

      for (const payment of payments) {
        try {
          await this.dataMapper.upsertPayment(connection.orgId, 'xero', payment);
          result.paymentsUpserted++;
        } catch (err) {
          result.errors.push(`Payment ${payment.paymentID}: ${err.message}`);
          result.recordsFailed++;
        }
      }

      // Xero returns max 100 per page; fewer means we're on the last page
      if (payments.length < PAGE_SIZE) break;
      page++;
    }
  }

  /** Fetch and store the Xero organisation details for this connection */
  private async syncOrganisation(
    xero: XeroClient,
    tenantId: string,
    connection: AccountingConnection,
  ): Promise<void> {
    try {
      const resp = await withRateLimit(() =>
        xero.accountingApi.getOrganisations(tenantId),
      );
      const org = resp.body.organisations?.[0];
      if (org) {
        await this.dataMapper.upsertOrganisation(
          connection._id as any,
          connection.orgId,
          org,
        );
        this.logger.log(`Synced Xero org: ${org.name} (${org.baseCurrency})`);
      }
    } catch (err) {
      // Non-fatal: org info is display-only. Log and continue sync.
      this.logger.warn(`Failed to sync Xero organisation info: ${err.message}`);
    }
  }

  private emptyResult(): SyncResult {
    return {
      contactsUpserted: 0,
      invoicesUpserted: 0,
      paymentsUpserted: 0,
      recordsSkipped: 0,
      recordsFailed: 0,
      errors: [],
    };
  }
}
