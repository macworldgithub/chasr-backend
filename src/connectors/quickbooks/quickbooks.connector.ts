import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { BaseConnector, SyncResult } from '../base.connector';
import { VaultService } from '../../credential-vault/vault.service';
import { DataMapperService } from '../../sync/data-mapper.service';
import { AccountingConnection } from '../../integrations/schemas/accounting-connection.schema';
import { QuickBooksOAuthService } from './quickbooks-oauth.service';

const PAGE_SIZE = 100;

@Injectable()
export class QuickBooksConnector extends BaseConnector {
  private readonly logger = new Logger(QuickBooksConnector.name);

  constructor(
    private readonly vault: VaultService,
    private readonly dataMapper: DataMapperService,
    private readonly quickBooksOAuth: QuickBooksOAuthService,
  ) {
    super();
  }

  async fullSync(connection: AccountingConnection): Promise<SyncResult> {
    const client = await this.buildAuthenticatedClient(connection);
    const realmId = connection.credentials.realmId as string;
    const result = this.emptyResult();

    await this.syncContacts(client, realmId, connection, result, null);
    await this.syncInvoices(client, realmId, connection, result, null);
    await this.syncPayments(client, realmId, connection, result, null);

    return result;
  }

  async incrementalSync(connection: AccountingConnection): Promise<SyncResult> {
    const client = await this.buildAuthenticatedClient(connection);
    const realmId = connection.credentials.realmId as string;
    const result = this.emptyResult();

    const modifiedAfter = connection.lastSyncAt ?? null;
    await this.syncContacts(client, realmId, connection, result, modifiedAfter);
    await this.syncInvoices(client, realmId, connection, result, modifiedAfter);
    await this.syncPayments(client, realmId, connection, result, modifiedAfter);

    return result;
  }

  async processWebhookEvent(
    connection: AccountingConnection,
    webhookPayload: any,
  ): Promise<SyncResult> {
    const client = await this.buildAuthenticatedClient(connection);
    const realmId = connection.credentials.realmId as string;
    const result = this.emptyResult();

    const payload = webhookPayload ?? {};
    const eventType = payload.eventType ?? payload.name;
    const entityName = payload.entityName ?? payload.resourceType;

    if (!entityName) {
      result.recordsSkipped++;
      return result;
    }

    if (entityName === 'Invoice') {
      const invoiceId = payload.id ?? payload.entityId;
      if (!invoiceId) {
        result.recordsSkipped++;
        return result;
      }

      const invoice = await this.fetchInvoice(client, realmId, invoiceId);
      if (invoice) {
        await this.dataMapper.upsertInvoice(
          connection.orgId,
          'quickbooks',
          invoice,
        );
        result.invoicesUpserted++;
      }
      return result;
    }

    if (entityName === 'Customer') {
      const customerId = payload.id ?? payload.entityId;
      if (!customerId) {
        result.recordsSkipped++;
        return result;
      }

      const customer = await this.fetchCustomer(client, realmId, customerId);
      if (customer) {
        await this.dataMapper.upsertContact(
          connection.orgId,
          'quickbooks',
          customer,
        );
        result.contactsUpserted++;
      }
      return result;
    }

    this.logger.warn(
      `Unsupported QuickBooks webhook eventType=${eventType} entityName=${entityName}`,
    );
    result.recordsSkipped++;
    return result;
  }

  async refreshTokensIfNeeded(
    connection: AccountingConnection,
  ): Promise<AccountingConnection> {
    const expiresAt = connection.credentials.tokenExpiresAt as Date;
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

    if (expiresAt <= fiveMinutesFromNow) {
      this.logger.log(
        `Refreshing QuickBooks token for connection ${connection._id} (expires ${expiresAt.toISOString()})`,
      );
      return this.quickBooksOAuth.refreshAccessToken(connection);
    }

    return connection;
  }

  async validateConnection(connection: AccountingConnection): Promise<boolean> {
    try {
      const client = await this.buildAuthenticatedClient(connection);
      const realmId = connection.credentials.realmId as string;
      await client.get(`company/${realmId}/companyinfo/${realmId}`);
      return true;
    } catch {
      return false;
    }
  }

  async revokeAccess(connection: AccountingConnection): Promise<void> {
    await this.quickBooksOAuth.revokeTokens(connection);
  }

  private async buildAuthenticatedClient(connection: AccountingConnection) {
    const refreshed = await this.refreshTokensIfNeeded(connection);
    const accessToken = this.vault.decrypt(
      refreshed.credentials.encryptedAccessToken,
    );

    const baseURL = `https://quickbooks.api.intuit.com/v3/company/${refreshed.credentials.realmId}`;

    return {
      baseURL,
      accessToken,
      async get(path: string) {
        return axios.get(`${baseURL}/${path.replace(/^\//, '')}`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
        });
      },
    };
  }

  private async syncContacts(
    client: any,
    realmId: string,
    connection: AccountingConnection,
    result: SyncResult,
    modifiedAfter: Date | null,
  ): Promise<void> {
    let startPosition = 1;

    while (true) {
      const url = `/company/${realmId}/customer?results=100&startposition=${startPosition}`;
      const resp = await client.get(url);
      const customers = resp.data.QueryResponse?.Customer ?? [];

      if (customers.length === 0) break;

      for (const customer of customers) {
        try {
          await this.dataMapper.upsertContact(
            connection.orgId,
            'quickbooks',
            customer,
          );
          result.contactsUpserted++;
        } catch (err: any) {
          result.errors.push(`Customer ${customer.Id}: ${err.message}`);
          result.recordsFailed++;
        }
      }

      if (customers.length < PAGE_SIZE) break;
      startPosition += PAGE_SIZE;
    }
  }

  private async syncInvoices(
    client: any,
    realmId: string,
    connection: AccountingConnection,
    result: SyncResult,
    modifiedAfter: Date | null,
  ): Promise<void> {
    const lookbackMonths =
      (connection.settings?.lookbackMonths as number) ?? 18;
    const since =
      modifiedAfter ??
      new Date(Date.now() - lookbackMonths * 30 * 24 * 60 * 60 * 1000);
    let startPosition = 1;

    while (true) {
      const url = `/company/${realmId}/invoice?results=100&startposition=${startPosition}`;
      const resp = await client.get(url);
      const invoices = resp.data.QueryResponse?.Invoice ?? [];

      if (invoices.length === 0) break;

      for (const invoice of invoices) {
        const invoiceDate = invoice.TxnDate ? new Date(invoice.TxnDate) : null;
        if (invoiceDate && modifiedAfter && invoiceDate < since) {
          continue;
        }

        try {
          await this.dataMapper.upsertInvoice(
            connection.orgId,
            'quickbooks',
            invoice,
          );
          result.invoicesUpserted++;
        } catch (err: any) {
          result.errors.push(`Invoice ${invoice.Id}: ${err.message}`);
          result.recordsFailed++;
        }
      }

      if (invoices.length < PAGE_SIZE) break;
      startPosition += PAGE_SIZE;
    }
  }

  private async syncPayments(
    client: any,
    realmId: string,
    connection: AccountingConnection,
    result: SyncResult,
    modifiedAfter: Date | null,
  ): Promise<void> {
    let startPosition = 1;

    while (true) {
      const url = `/company/${realmId}/payment?results=100&startposition=${startPosition}`;
      const resp = await client.get(url);
      const payments = resp.data.QueryResponse?.Payment ?? [];

      if (payments.length === 0) break;

      for (const payment of payments) {
        try {
          await this.dataMapper.upsertPayment(
            connection.orgId,
            'quickbooks',
            payment,
          );
          result.paymentsUpserted++;
        } catch (err: any) {
          result.errors.push(`Payment ${payment.Id}: ${err.message}`);
          result.recordsFailed++;
        }
      }

      if (payments.length < PAGE_SIZE) break;
      startPosition += PAGE_SIZE;
    }
  }

  private async fetchInvoice(client: any, realmId: string, invoiceId: string) {
    const resp = await client.get(`/company/${realmId}/invoice/${invoiceId}`);
    return resp.data.Invoice ?? resp.data.QueryResponse?.Invoice?.[0] ?? null;
  }

  private async fetchCustomer(
    client: any,
    realmId: string,
    customerId: string,
  ) {
    const resp = await client.get(`/company/${realmId}/customer/${customerId}`);
    return resp.data.Customer ?? resp.data.QueryResponse?.Customer?.[0] ?? null;
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
