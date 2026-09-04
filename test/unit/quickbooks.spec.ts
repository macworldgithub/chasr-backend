import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import axios from 'axios';
import * as crypto from 'crypto';
import {
  QuickBooksOAuthService,
  getQuickBooksApiBaseUrl,
} from '../../src/connectors/quickbooks/quickbooks-oauth.service';
import { QuickBooksConnector } from '../../src/connectors/quickbooks/quickbooks.connector';
import { QuickBooksWebhookHandler } from '../../src/connectors/quickbooks/quickbooks-webhook.handler';
import { VaultService } from '../../src/credential-vault/vault.service';
import { AuditLoggerService } from '../../src/audit/audit-logger.service';
import { DataMapperService } from '../../src/sync/data-mapper.service';
import { AccountingConnection } from '../../src/integrations/schemas/accounting-connection.schema';
import { SyncLog } from '../../src/integrations/schemas/sync-log.schema';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('QuickBooks Online Integration Suite', () => {
  let oauthService: QuickBooksOAuthService;
  let connector: QuickBooksConnector;
  let webhookHandler: QuickBooksWebhookHandler;

  let mockConnectionModel: any;
  let mockSyncLogModel: any;
  let mockVault: any;
  let mockAuditLogger: any;
  let mockDataMapper: any;
  let mockSyncQueue: any;

  beforeEach(async () => {
    process.env.QUICKBOOKS_CLIENT_ID = 'test-qb-client-id';
    process.env.QUICKBOOKS_CLIENT_SECRET = 'test-qb-client-secret';
    process.env.QUICKBOOKS_REDIRECT_URI =
      'https://app.chasr.com/integrations/quickbooks/callback';
    process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN =
      'test-webhook-verifier-token';
    delete process.env.QUICKBOOKS_ENVIRONMENT;
    delete process.env.QUICKBOOKS_BASE_URL;

    mockConnectionModel = {
      findOneAndUpdate: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      updateOne: jest.fn(),
    };

    mockSyncLogModel = {
      create: jest.fn().mockImplementation((doc) => ({
        _id: new Types.ObjectId(),
        ...doc,
      })),
      updateOne: jest.fn(),
    };

    mockVault = {
      encrypt: jest.fn((val: string) => `encrypted:${val}`),
      decrypt: jest.fn((val: string) => val.replace('encrypted:', '')),
    };

    mockAuditLogger = {
      log: jest.fn().mockResolvedValue(true),
    };

    mockDataMapper = {
      upsertContact: jest.fn().mockResolvedValue(undefined),
      upsertInvoice: jest.fn().mockResolvedValue(undefined),
      upsertPayment: jest.fn().mockResolvedValue(undefined),
      upsertCreditMemo: jest.fn().mockResolvedValue(undefined),
    };

    mockSyncQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuickBooksOAuthService,
        QuickBooksConnector,
        QuickBooksWebhookHandler,
        {
          provide: getModelToken(AccountingConnection.name),
          useValue: mockConnectionModel,
        },
        {
          provide: getModelToken(SyncLog.name),
          useValue: mockSyncLogModel,
        },
        {
          provide: VaultService,
          useValue: mockVault,
        },
        {
          provide: AuditLoggerService,
          useValue: mockAuditLogger,
        },
        {
          provide: DataMapperService,
          useValue: mockDataMapper,
        },
        {
          provide: 'BullQueue_accounting-sync',
          useValue: mockSyncQueue,
        },
      ],
    }).compile();

    oauthService = module.get<QuickBooksOAuthService>(QuickBooksOAuthService);
    connector = module.get<QuickBooksConnector>(QuickBooksConnector);
    webhookHandler = module.get<QuickBooksWebhookHandler>(
      QuickBooksWebhookHandler,
    );

    // Mock internal Redis in oauthService to prevent hanging handles
    (oauthService as any).redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Base URL Resolution', () => {
    it('should return sandbox url by default', () => {
      expect(getQuickBooksApiBaseUrl()).toBe(
        'https://sandbox-quickbooks.api.intuit.com',
      );
    });

    it('should return production url when QUICKBOOKS_ENVIRONMENT=production', () => {
      process.env.QUICKBOOKS_ENVIRONMENT = 'production';
      expect(getQuickBooksApiBaseUrl()).toBe(
        'https://quickbooks.api.intuit.com',
      );
    });

    it('should return custom url if QUICKBOOKS_BASE_URL is set', () => {
      process.env.QUICKBOOKS_BASE_URL = 'https://custom-qb-proxy.com/';
      expect(getQuickBooksApiBaseUrl()).toBe('https://custom-qb-proxy.com');
    });
  });

  describe('Authentication (APIs 1, 2, 3, 4, 15)', () => {
    it('API 1: generateAuthUrl should generate state and OAuth 2.0 URL', async () => {
      const orgId = new Types.ObjectId().toString();
      const userId = 'user-1';

      const result = await oauthService.generateAuthUrl(orgId, userId);

      expect(result.authUrl).toContain(
        'https://appcenter.intuit.com/connect/oauth2',
      );
      expect(result.authUrl).toContain(
        `client_id=${process.env.QUICKBOOKS_CLIENT_ID}`,
      );
      expect(result.authUrl).toContain(
        'scope=com.intuit.quickbooks.accounting',
      );
      expect(result.state).toBeDefined();
    });

    it('API 2 & 15: exchangeCode should exchange code for tokens and fetch company info', async () => {
      const orgId = new Types.ObjectId().toString();
      const userId = 'user-1';
      const state = 'valid-state';

      (oauthService as any).redis.get.mockResolvedValue(
        JSON.stringify({ orgId, userId }),
      );

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'qb-access-token',
          refresh_token: 'qb-refresh-token',
          expires_in: 3600,
          x_refresh_token_expires_in: 8726400,
          realmId: '123456789',
        },
      } as any);

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          CompanyInfo: {
            CompanyName: 'Acme Test Corp',
            Country: 'US',
            DefaultCurrency: 'USD',
          },
        },
      } as any);

      const fakeConnection = {
        _id: new Types.ObjectId(),
        orgId: new Types.ObjectId(orgId),
        provider: 'quickbooks',
        status: 'connected',
      };
      mockConnectionModel.findOneAndUpdate.mockResolvedValue(fakeConnection);

      const res = await oauthService.exchangeCode(
        'auth-code-123',
        state,
        '123456789',
      );

      expect(res).toBeDefined();
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
        expect.any(URLSearchParams),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringMatching(/^Basic /),
          }),
        }),
      );
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/v3/company/123456789/companyinfo/123456789'),
        expect.any(Object),
      );
    });

    it('API 3: refreshAccessToken should refresh expired tokens and update DB', async () => {
      const mockConn: any = {
        _id: new Types.ObjectId(),
        credentials: {
          encryptedRefreshToken: 'encrypted:old-refresh-token',
        },
      };

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
          x_refresh_token_expires_in: 8726400,
        },
      } as any);

      mockConnectionModel.findByIdAndUpdate.mockResolvedValue({
        ...mockConn,
        credentials: {
          encryptedAccessToken: 'encrypted:new-access-token',
          encryptedRefreshToken: 'encrypted:new-refresh-token',
        },
      });

      const updated = await oauthService.refreshAccessToken(mockConn);

      expect(updated).toBeDefined();
      expect(mockVault.decrypt).toHaveBeenCalledWith(
        'encrypted:old-refresh-token',
      );
      expect(mockVault.encrypt).toHaveBeenCalledWith('new-access-token');
      expect(mockVault.encrypt).toHaveBeenCalledWith('new-refresh-token');
    });

    it('API 4: revokeTokens should call revoke endpoint', async () => {
      const mockConn: any = {
        _id: new Types.ObjectId(),
        credentials: {
          encryptedRefreshToken: 'encrypted:ref-token',
        },
      };

      mockedAxios.post.mockResolvedValueOnce({ data: {} } as any);

      await oauthService.revokeTokens(mockConn);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
        expect.any(URLSearchParams),
        expect.any(Object),
      );
    });
  });

  describe('QuickBooksConnector Queries & Sync (APIs 5-15)', () => {
    let fakeConnection: any;

    beforeEach(() => {
      fakeConnection = {
        _id: new Types.ObjectId(),
        orgId: new Types.ObjectId(),
        provider: 'quickbooks',
        credentials: {
          encryptedAccessToken: 'encrypted:valid-token',
          encryptedRefreshToken: 'encrypted:valid-refresh',
          tokenExpiresAt: new Date(Date.now() + 3600 * 1000),
          realmId: '123456789',
        },
        settings: {
          lookbackMonths: 18,
        },
      };
    });

    it('API 5: queryCustomers should execute Customer query and map contacts', async () => {
      const client = {
        query: jest.fn().mockResolvedValue({
          data: {
            QueryResponse: {
              Customer: [{ Id: 'cust-1', DisplayName: 'John Doe' }],
            },
          },
        }),
      };

      const customers = await connector.queryCustomers(client as any, 1, 100);
      expect(customers).toHaveLength(1);
      expect(customers[0].Id).toBe('cust-1');
      expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'SELECT * FROM Customer STARTPOSITION 1 MAXRESULTS 100',
        ),
      );
    });

    it('API 6: fetchCustomer should get single customer by ID', async () => {
      const client = {
        get: jest.fn().mockResolvedValue({
          data: {
            Customer: { Id: 'cust-99', DisplayName: 'Alice' },
          },
        }),
      };

      const customer = await connector.fetchCustomer(
        client as any,
        '123456789',
        'cust-99',
      );
      expect(customer).toBeDefined();
      expect(customer.DisplayName).toBe('Alice');
      expect(client.get).toHaveBeenCalledWith('/customer/cust-99');
    });

    it('API 7: queryInvoices should query invoices with pagination', async () => {
      const client = {
        query: jest.fn().mockResolvedValue({
          data: {
            QueryResponse: {
              Invoice: [{ Id: 'inv-1', DocNumber: 'INV-1001', TotalAmt: 500 }],
            },
          },
        }),
      };

      const invoices = await connector.queryInvoices(client as any, 1, 100);
      expect(invoices).toHaveLength(1);
      expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'SELECT * FROM Invoice STARTPOSITION 1 MAXRESULTS 100',
        ),
      );
    });

    it('API 8: queryOverdueInvoices should query overdue invoices with DueDate filter', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          QueryResponse: {
            Invoice: [
              { Id: 'inv-overdue-1', Balance: 350, DueDate: '2026-01-01' },
            ],
          },
        },
      } as any);

      const overdueInvoices = await connector.queryOverdueInvoices(
        fakeConnection,
        new Date('2026-03-01'),
      );

      expect(overdueInvoices).toHaveLength(1);
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/query'),
        expect.objectContaining({
          params: expect.objectContaining({
            query: expect.stringContaining(
              "WHERE DueDate < '2026-03-01' AND Balance > '0'",
            ),
          }),
        }),
      );
    });

    it('API 9: fetchInvoice should get single invoice by ID', async () => {
      const client = {
        get: jest.fn().mockResolvedValue({
          data: {
            Invoice: { Id: 'inv-42', DocNumber: 'INV-42', TotalAmt: 120 },
          },
        }),
      };

      const inv = await connector.fetchInvoice(
        client as any,
        '123456789',
        'inv-42',
      );
      expect(inv.DocNumber).toBe('INV-42');
      expect(client.get).toHaveBeenCalledWith('/invoice/inv-42');
    });

    it('API 10: queryPayments should query payments', async () => {
      const client = {
        query: jest.fn().mockResolvedValue({
          data: {
            QueryResponse: {
              Payment: [{ Id: 'pay-1', TotalAmt: 200 }],
            },
          },
        }),
      };

      const payments = await connector.queryPayments(client as any, 1, 100);
      expect(payments).toHaveLength(1);
      expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'SELECT * FROM Payment STARTPOSITION 1 MAXRESULTS 100',
        ),
      );
    });

    it('API 11: fetchPayment should get single payment by ID', async () => {
      const client = {
        get: jest.fn().mockResolvedValue({
          data: {
            Payment: { Id: 'pay-88', TotalAmt: 50 },
          },
        }),
      };

      const pay = await connector.fetchPayment(
        client as any,
        '123456789',
        'pay-88',
      );
      expect(pay.Id).toBe('pay-88');
      expect(client.get).toHaveBeenCalledWith('/payment/pay-88');
    });

    it('API 12: queryCreditMemos should query credit memos', async () => {
      const client = {
        query: jest.fn().mockResolvedValue({
          data: {
            QueryResponse: {
              CreditMemo: [{ Id: 'cm-1', TotalAmt: 80, RemainingCredit: 0 }],
            },
          },
        }),
      };

      const creditMemos = await connector.queryCreditMemos(
        client as any,
        1,
        100,
      );
      expect(creditMemos).toHaveLength(1);
      expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'SELECT * FROM CreditMemo STARTPOSITION 1 MAXRESULTS 100',
        ),
      );
    });

    it('API 13: fetchCreditMemo should get single credit memo by ID', async () => {
      const client = {
        get: jest.fn().mockResolvedValue({
          data: {
            CreditMemo: { Id: 'cm-55', TotalAmt: 75 },
          },
        }),
      };

      const cm = await connector.fetchCreditMemo(
        client as any,
        '123456789',
        'cm-55',
      );
      expect(cm.Id).toBe('cm-55');
      expect(client.get).toHaveBeenCalledWith('/creditmemo/cm-55');
    });

    it('API 14: changeDataCapture and incrementalSync should parse CDC responses', async () => {
      fakeConnection.lastSyncAt = new Date(Date.now() - 15 * 60 * 1000);

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          CDCResponse: [
            {
              QueryResponse: [
                {
                  Customer: [
                    { Id: 'cdc-cust-1', DisplayName: 'Updated Customer' },
                  ],
                  Invoice: [
                    { Id: 'cdc-inv-1', DocNumber: 'INV-CDC', TotalAmt: 100 },
                  ],
                  Payment: [{ Id: 'cdc-pay-1', TotalAmt: 100 }],
                  CreditMemo: [{ Id: 'cdc-cm-1', TotalAmt: 50 }],
                },
              ],
            },
          ],
        },
      } as any);

      const result = await connector.incrementalSync(fakeConnection);

      expect(result.contactsUpserted).toBe(1);
      expect(result.invoicesUpserted).toBe(1);
      expect(result.paymentsUpserted).toBe(2); // 1 payment + 1 credit memo
      expect(mockDataMapper.upsertContact).toHaveBeenCalled();
      expect(mockDataMapper.upsertInvoice).toHaveBeenCalled();
      expect(mockDataMapper.upsertPayment).toHaveBeenCalled();
      expect(mockDataMapper.upsertCreditMemo).toHaveBeenCalled();
    });

    it('API 15: validateConnection and fetchCompanyInfo should verify connection health', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          CompanyInfo: { CompanyName: 'Live Corp', Country: 'AU' },
        },
      } as any);

      const isValid = await connector.validateConnection(fakeConnection);
      expect(isValid).toBe(true);
    });

    it('API 17: processWebhookEvent should handle Invoice, Customer, Payment, CreditMemo events', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          Payment: { Id: 'pay-hook-1', TotalAmt: 250 },
        },
      } as any);

      const result = await connector.processWebhookEvent(fakeConnection, {
        entityName: 'Payment',
        id: 'pay-hook-1',
        operation: 'Create',
      });

      expect(result.paymentsUpserted).toBe(1);
      expect(mockDataMapper.upsertPayment).toHaveBeenCalledWith(
        fakeConnection.orgId,
        'quickbooks',
        expect.objectContaining({ Id: 'pay-hook-1' }),
      );
    });
  });

  describe('QuickBooks Webhook Handler (APIs 16 & 17)', () => {
    it('should verify intuit-signature and enqueue BullMQ jobs', async () => {
      const realmId = '123456789';
      const rawPayload = JSON.stringify({
        eventNotifications: [
          {
            realmId,
            dataChangeEvent: {
              entities: [
                {
                  name: 'Invoice',
                  id: 'inv-webhook-10',
                  operation: 'Update',
                  lastUpdated: '2026-09-02T00:00:00Z',
                },
              ],
            },
          },
        ],
      });

      const signature = crypto
        .createHmac('sha256', process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN!)
        .update(Buffer.from(rawPayload))
        .digest('base64');

      const mockConn = {
        _id: new Types.ObjectId(),
        orgId: new Types.ObjectId(),
        provider: 'quickbooks',
      };
      mockConnectionModel.findOne.mockResolvedValue(mockConn);

      const req: any = {
        rawBody: Buffer.from(rawPayload),
      };

      const resp = await webhookHandler.handleQuickBooksWebhook(signature, req);

      expect(resp.status).toBe(200);
      expect(mockSyncLogModel.create).toHaveBeenCalled();
      expect(mockSyncQueue.add).toHaveBeenCalledWith(
        'webhook-event',
        expect.objectContaining({
          type: 'webhook_event',
          connectionId: mockConn._id.toString(),
          orgId: mockConn.orgId.toString(),
          webhookPayload: expect.objectContaining({
            entityName: 'Invoice',
            entityId: 'inv-webhook-10',
          }),
        }),
        { priority: 1 },
      );
    });

    it('should throw UnauthorizedException on invalid signature', async () => {
      const rawPayload = JSON.stringify({ eventNotifications: [] });
      const req: any = {
        rawBody: Buffer.from(rawPayload),
      };

      await expect(
        webhookHandler.handleQuickBooksWebhook('invalid-signature', req),
      ).rejects.toThrow();
    });
  });
});
