import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { BaseConnector, SyncResult } from '../base.connector';
import { VaultService } from '../../credential-vault/vault.service';
import { DataMapperService } from '../../sync/data-mapper.service';
import { AccountingConnection } from '../../integrations/schemas/accounting-connection.schema';
import {
  QuickBooksOAuthService,
  getQuickBooksApiBaseUrl,
} from './quickbooks-oauth.service';

const PAGE_SIZE = 100;

export interface QuickBooksClient {
  baseURL: string;
  accessToken: string;
  realmId: string;
  get(path: string, params?: Record<string, any>): Promise<any>;
  query(sql: string): Promise<any>;
}

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

  // ── Public BaseConnector implementation ─────────────────────────────────────

  /**
   * Full historical sync — queries all Customers, Invoices, Payments, and Credit Memos.
   */
  async fullSync(connection: AccountingConnection): Promise<SyncResult> {
    const client = await this.buildAuthenticatedClient(connection);
    const realmId = (connection.credentials.realmId || connection.credentials.tenantId) as string;
    const result = this.emptyResult();

    await this.syncContacts(client, realmId, connection, result, null);
    await this.syncInvoices(client, realmId, connection, result, null);
    await this.syncPayments(client, realmId, connection, result, null);
    await this.syncCreditMemos(client, realmId, connection, result, null);

    return result;
  }

  /**
   * Incremental sync — uses QuickBooks Change Data Capture (CDC) API (API #14)
   * to poll only modified records within the sync window, falling back to delta queries
   * if CDC window exceeds 30 days.
   */
  async incrementalSync(connection: AccountingConnection): Promise<SyncResult> {
    const client = await this.buildAuthenticatedClient(connection);
    const realmId = (connection.credentials.realmId || connection.credentials.tenantId) as string;
    const result = this.emptyResult();

    const modifiedAfter =
      connection.lastSyncAt ??
      new Date(Date.now() - 30 * 60 * 1000); // default to 30 mins ago

    const thirtyDaysAgo = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);

    // QuickBooks CDC supports changedSince timestamps up to 30 days
    if (modifiedAfter >= thirtyDaysAgo) {
      try {
        await this.syncViaCDC(client, realmId, connection, result, modifiedAfter);
        return result;
      } catch (err: any) {
        this.logger.warn(
          `QuickBooks CDC sync failed (${err.message}). Falling back to delta queries.`,
        );
      }
    }

    // Fallback: standard delta queries
    await this.syncContacts(client, realmId, connection, result, modifiedAfter);
    await this.syncInvoices(client, realmId, connection, result, modifiedAfter);
    await this.syncPayments(client, realmId, connection, result, modifiedAfter);
    await this.syncCreditMemos(client, realmId, connection, result, modifiedAfter);

    return result;
  }

  /**
   * Process inbound webhook events for Customer, Invoice, Payment, CreditMemo (API #17).
   */
  async processWebhookEvent(
    connection: AccountingConnection,
    webhookPayload: any,
  ): Promise<SyncResult> {
    const client = await this.buildAuthenticatedClient(connection);
    const realmId = (connection.credentials.realmId || connection.credentials.tenantId) as string;
    const result = this.emptyResult();

    const payload = webhookPayload ?? {};
    const eventType = payload.eventType ?? payload.name ?? payload.operation;
    const entityName =
      payload.entityName ?? payload.name ?? payload.resourceType;
    const entityId = payload.id ?? payload.entityId ?? payload.resourceId;

    if (!entityName || !entityId) {
      result.recordsSkipped++;
      return result;
    }

    // Handle delete operation
    if (eventType === 'Delete' || eventType === 'Void') {
      if (entityName === 'Invoice') {
        await this.dataMapper.upsertInvoice(connection.orgId, 'quickbooks', {
          Id: entityId,
          Balance: 0,
          TotalAmt: 0,
          PrivateNote: 'VOID',
        });
        result.invoicesUpserted++;
        return result;
      }
    }

    switch (entityName) {
      case 'Invoice': {
        const invoice = await this.fetchInvoice(client, realmId, entityId);
        if (invoice) {
          await this.dataMapper.upsertInvoice(
            connection.orgId,
            'quickbooks',
            invoice,
          );
          result.invoicesUpserted++;
        } else {
          result.recordsSkipped++;
        }
        break;
      }

      case 'Customer': {
        const customer = await this.fetchCustomer(client, realmId, entityId);
        if (customer) {
          await this.dataMapper.upsertContact(
            connection.orgId,
            'quickbooks',
            customer,
          );
          result.contactsUpserted++;
        } else {
          result.recordsSkipped++;
        }
        break;
      }

      case 'Payment': {
        const payment = await this.fetchPayment(client, realmId, entityId);
        if (payment) {
          await this.dataMapper.upsertPayment(
            connection.orgId,
            'quickbooks',
            payment,
          );
          result.paymentsUpserted++;
        } else {
          result.recordsSkipped++;
        }
        break;
      }

      case 'CreditMemo': {
        const creditMemo = await this.fetchCreditMemo(client, realmId, entityId);
        if (creditMemo) {
          await this.dataMapper.upsertCreditMemo(
            connection.orgId,
            'quickbooks',
            creditMemo,
          );
          result.paymentsUpserted++; // Count credit adjustment towards payment/balance upserts
        } else {
          result.recordsSkipped++;
        }
        break;
      }

      default:
        this.logger.warn(
          `Unsupported QuickBooks webhook entityName=${entityName} eventType=${eventType}`,
        );
        result.recordsSkipped++;
        break;
    }

    return result;
  }

  /**
   * Token refresh if expires within 5 minutes (API #3).
   */
  async refreshTokensIfNeeded(
    connection: AccountingConnection,
  ): Promise<AccountingConnection> {
    const expiresAt = connection.credentials.tokenExpiresAt as Date;
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

    if (expiresAt <= fiveMinutesFromNow) {
      this.logger.log(
        `Refreshing QuickBooks token for connection ${connection._id} (expires ${expiresAt ? new Date(expiresAt).toISOString() : 'unknown'})`,
      );
      return this.quickBooksOAuth.refreshAccessToken(connection);
    }

    return connection;
  }

  /**
   * Validate connection using CompanyInfo API (API #15).
   */
  async validateConnection(connection: AccountingConnection): Promise<boolean> {
    try {
      const client = await this.buildAuthenticatedClient(connection);
      const realmId = (connection.credentials.realmId || connection.credentials.tenantId) as string;
      await this.fetchCompanyInfo(client, realmId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Revoke provider-side tokens (API #4).
   */
  async revokeAccess(connection: AccountingConnection): Promise<void> {
    await this.quickBooksOAuth.revokeTokens(connection);
  }

  // ── Specific QuickBooks API Methods (17 API Implementation) ────────────────

  /**
   * API #15: Get Company Info
   * GET /v3/company/{realmId}/companyinfo/{realmId}
   */
  async fetchCompanyInfo(clientOrConnection: QuickBooksClient | AccountingConnection, realmIdOverride?: string): Promise<any> {
    const client = 'baseURL' in clientOrConnection
      ? clientOrConnection
      : await this.buildAuthenticatedClient(clientOrConnection);
    const realmId = realmIdOverride || client.realmId;
    const resp = await client.get(`/companyinfo/${realmId}`);
    return resp.data.CompanyInfo ?? resp.data.companyInfo ?? null;
  }

  /**
   * API #5: Query All Customers
   * GET /v3/company/{realmId}/query?query=SELECT * FROM Customer STARTPOSITION {x} MAXRESULTS {y}
   */
  async queryCustomers(
    client: QuickBooksClient,
    startPosition = 1,
    maxResults = PAGE_SIZE,
    modifiedAfter: Date | null = null,
  ): Promise<any[]> {
    let sql = 'SELECT * FROM Customer';
    if (modifiedAfter) {
      sql += ` WHERE MetaData.LastUpdatedTime > '${modifiedAfter.toISOString()}'`;
    }
    sql += ` STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;

    const resp = await client.query(sql);
    return resp.data.QueryResponse?.Customer ?? [];
  }

  /**
   * API #6: Get Single Customer
   * GET /v3/company/{realmId}/customer/{id}
   */
  async fetchCustomer(
    client: QuickBooksClient,
    realmId: string,
    customerId: string,
  ): Promise<any> {
    const resp = await client.get(`/customer/${customerId}`);
    return resp.data.Customer ?? resp.data.QueryResponse?.Customer?.[0] ?? null;
  }

  /**
   * API #7: Query All Invoices
   * GET /v3/company/{realmId}/query?query=SELECT * FROM Invoice STARTPOSITION {x} MAXRESULTS {y}
   */
  async queryInvoices(
    client: QuickBooksClient,
    startPosition = 1,
    maxResults = PAGE_SIZE,
    modifiedAfter: Date | null = null,
  ): Promise<any[]> {
    let sql = 'SELECT * FROM Invoice';
    if (modifiedAfter) {
      sql += ` WHERE MetaData.LastUpdatedTime > '${modifiedAfter.toISOString()}'`;
    }
    sql += ` STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;

    const resp = await client.query(sql);
    return resp.data.QueryResponse?.Invoice ?? [];
  }

  /**
   * API #8: Query Overdue Invoices
   * GET /v3/company/{realmId}/query?query=SELECT * FROM Invoice WHERE DueDate < '{today}' STARTPOSITION {x} MAXRESULTS {y}
   */
  async queryOverdueInvoices(
    connection: AccountingConnection,
    asOfDate: Date = new Date(),
    startPosition = 1,
    maxResults = PAGE_SIZE,
  ): Promise<any[]> {
    const client = await this.buildAuthenticatedClient(connection);
    const dateStr = asOfDate.toISOString().split('T')[0];
    const sql = `SELECT * FROM Invoice WHERE DueDate < '${dateStr}' AND Balance > '0' STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;

    const resp = await client.query(sql);
    return resp.data.QueryResponse?.Invoice ?? [];
  }

  /**
   * API #9: Get Single Invoice
   * GET /v3/company/{realmId}/invoice/{id}
   */
  async fetchInvoice(
    client: QuickBooksClient,
    realmId: string,
    invoiceId: string,
  ): Promise<any> {
    const resp = await client.get(`/invoice/${invoiceId}`);
    return resp.data.Invoice ?? resp.data.QueryResponse?.Invoice?.[0] ?? null;
  }

  /**
   * API #10: Query All Payments
   * GET /v3/company/{realmId}/query?query=SELECT * FROM Payment STARTPOSITION {x} MAXRESULTS {y}
   */
  async queryPayments(
    client: QuickBooksClient,
    startPosition = 1,
    maxResults = PAGE_SIZE,
    modifiedAfter: Date | null = null,
  ): Promise<any[]> {
    let sql = 'SELECT * FROM Payment';
    if (modifiedAfter) {
      sql += ` WHERE MetaData.LastUpdatedTime > '${modifiedAfter.toISOString()}'`;
    }
    sql += ` STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;

    const resp = await client.query(sql);
    return resp.data.QueryResponse?.Payment ?? [];
  }

  /**
   * API #11: Get Single Payment
   * GET /v3/company/{realmId}/payment/{id}
   */
  async fetchPayment(
    client: QuickBooksClient,
    realmId: string,
    paymentId: string,
  ): Promise<any> {
    const resp = await client.get(`/payment/${paymentId}`);
    return resp.data.Payment ?? resp.data.QueryResponse?.Payment?.[0] ?? null;
  }

  /**
   * API #12: Query Credit Memos
   * GET /v3/company/{realmId}/query?query=SELECT * FROM CreditMemo STARTPOSITION {x} MAXRESULTS {y}
   */
  async queryCreditMemos(
    client: QuickBooksClient,
    startPosition = 1,
    maxResults = PAGE_SIZE,
    modifiedAfter: Date | null = null,
  ): Promise<any[]> {
    let sql = 'SELECT * FROM CreditMemo';
    if (modifiedAfter) {
      sql += ` WHERE MetaData.LastUpdatedTime > '${modifiedAfter.toISOString()}'`;
    }
    sql += ` STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;

    const resp = await client.query(sql);
    return resp.data.QueryResponse?.CreditMemo ?? [];
  }

  /**
   * API #13: Get Single Credit Memo
   * GET /v3/company/{realmId}/creditmemo/{id}
   */
  async fetchCreditMemo(
    client: QuickBooksClient,
    realmId: string,
    creditMemoId: string,
  ): Promise<any> {
    const resp = await client.get(`/creditmemo/${creditMemoId}`);
    return resp.data.CreditMemo ?? resp.data.QueryResponse?.CreditMemo?.[0] ?? null;
  }

  /**
   * API #14: Change Data Capture (CDC)
   * GET /v3/company/{realmId}/cdc?entities=Customer,Invoice,Payment,CreditMemo&changedSince={timestamp}
   */
  async changeDataCapture(
    client: QuickBooksClient,
    realmId: string,
    entities = 'Customer,Invoice,Payment,CreditMemo',
    changedSince: Date = new Date(Date.now() - 30 * 60 * 1000),
  ): Promise<any> {
    const resp = await client.get('/cdc', {
      entities,
      changedSince: changedSince.toISOString(),
    });
    return resp.data.CDCResponse ?? [];
  }

  // ── Sync Internal Loops ───────────────────────────────────────────────────

  private async syncContacts(
    client: QuickBooksClient,
    realmId: string,
    connection: AccountingConnection,
    result: SyncResult,
    modifiedAfter: Date | null,
  ): Promise<void> {
    let startPosition = 1;

    while (true) {
      const customers = await this.queryCustomers(
        client,
        startPosition,
        PAGE_SIZE,
        modifiedAfter,
      );

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
    client: QuickBooksClient,
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
      const invoices = await this.queryInvoices(
        client,
        startPosition,
        PAGE_SIZE,
        modifiedAfter,
      );

      if (invoices.length === 0) break;

      for (const invoice of invoices) {
        const invoiceDate = invoice.TxnDate ? new Date(invoice.TxnDate) : null;
        if (invoiceDate && !modifiedAfter && invoiceDate < since) {
          result.recordsSkipped++;
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
    client: QuickBooksClient,
    realmId: string,
    connection: AccountingConnection,
    result: SyncResult,
    modifiedAfter: Date | null,
  ): Promise<void> {
    let startPosition = 1;

    while (true) {
      const payments = await this.queryPayments(
        client,
        startPosition,
        PAGE_SIZE,
        modifiedAfter,
      );

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

  private async syncCreditMemos(
    client: QuickBooksClient,
    realmId: string,
    connection: AccountingConnection,
    result: SyncResult,
    modifiedAfter: Date | null,
  ): Promise<void> {
    let startPosition = 1;

    while (true) {
      const creditMemos = await this.queryCreditMemos(
        client,
        startPosition,
        PAGE_SIZE,
        modifiedAfter,
      );

      if (creditMemos.length === 0) break;

      for (const creditMemo of creditMemos) {
        try {
          await this.dataMapper.upsertCreditMemo(
            connection.orgId,
            'quickbooks',
            creditMemo,
          );
          result.paymentsUpserted++;
        } catch (err: any) {
          result.errors.push(`CreditMemo ${creditMemo.Id}: ${err.message}`);
          result.recordsFailed++;
        }
      }

      if (creditMemos.length < PAGE_SIZE) break;
      startPosition += PAGE_SIZE;
    }
  }

  /**
   * Helper to perform incremental sync via CDC response parsing
   */
  private async syncViaCDC(
    client: QuickBooksClient,
    realmId: string,
    connection: AccountingConnection,
    result: SyncResult,
    changedSince: Date,
  ): Promise<void> {
    const cdcResponses = await this.changeDataCapture(
      client,
      realmId,
      'Customer,Invoice,Payment,CreditMemo',
      changedSince,
    );

    for (const cdcItem of cdcResponses) {
      const rawQr = cdcItem.QueryResponse;
      const queryResponses = Array.isArray(rawQr) ? rawQr : rawQr ? [rawQr] : [];
      for (const qr of queryResponses) {
        // Upsert Customers
        for (const customer of qr.Customer ?? []) {
          try {
            await this.dataMapper.upsertContact(
              connection.orgId,
              'quickbooks',
              customer,
            );
            result.contactsUpserted++;
          } catch (err: any) {
            result.errors.push(`CDC Customer ${customer.Id}: ${err.message}`);
            result.recordsFailed++;
          }
        }

        // Upsert Invoices
        for (const invoice of qr.Invoice ?? []) {
          try {
            await this.dataMapper.upsertInvoice(
              connection.orgId,
              'quickbooks',
              invoice,
            );
            result.invoicesUpserted++;
          } catch (err: any) {
            result.errors.push(`CDC Invoice ${invoice.Id}: ${err.message}`);
            result.recordsFailed++;
          }
        }

        // Upsert Payments
        for (const payment of qr.Payment ?? []) {
          try {
            await this.dataMapper.upsertPayment(
              connection.orgId,
              'quickbooks',
              payment,
            );
            result.paymentsUpserted++;
          } catch (err: any) {
            result.errors.push(`CDC Payment ${payment.Id}: ${err.message}`);
            result.recordsFailed++;
          }
        }

        // Upsert Credit Memos
        for (const creditMemo of qr.CreditMemo ?? []) {
          try {
            await this.dataMapper.upsertCreditMemo(
              connection.orgId,
              'quickbooks',
              creditMemo,
            );
            result.paymentsUpserted++;
          } catch (err: any) {
            result.errors.push(`CDC CreditMemo ${creditMemo.Id}: ${err.message}`);
            result.recordsFailed++;
          }
        }
      }
    }
  }

  private async buildAuthenticatedClient(
    connection: AccountingConnection,
  ): Promise<QuickBooksClient> {
    const refreshed = await this.refreshTokensIfNeeded(connection);
    const accessToken = this.vault.decrypt(
      refreshed.credentials.encryptedAccessToken,
    );
    const realmId = (refreshed.credentials.realmId || refreshed.credentials.tenantId) as string;
    const apiBase = getQuickBooksApiBaseUrl();
    const baseURL = `${apiBase}/v3/company/${realmId}`;

    return {
      baseURL,
      accessToken,
      realmId,
      async get(path: string, params?: Record<string, any>) {
        const url = `${baseURL}/${path.replace(/^\//, '')}`;
        return axios.get(url, {
          params,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
        });
      },
      async query(sql: string) {
        return axios.get(`${baseURL}/query`, {
          params: { query: sql },
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
        });
      },
    };
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
