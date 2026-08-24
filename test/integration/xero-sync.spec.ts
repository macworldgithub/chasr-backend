import { Test, TestingModule } from '@nestjs/testing';
import { SyncProcessor } from '../../src/sync/sync.processor';
import { ConnectorFactory } from '../../src/connectors/connector.factory';
import { XeroConnector } from '../../src/connectors/xero/xero.connector';
import { getModelToken } from '@nestjs/mongoose';
import { AccountingConnection } from '../../src/integrations/schemas/accounting-connection.schema';
import { SyncLog } from '../../src/integrations/schemas/sync-log.schema';
import { CsvConnector } from '../../src/connectors/csv/csv.connector';
import { AuditLoggerService } from '../../src/audit/audit-logger.service';

describe('Xero Sync Integration', () => {
  let processor: SyncProcessor;
  let mockXeroConnector: any;
  let mockConnectionModel: any;
  let mockSyncLogModel: any;

  beforeEach(async () => {
    mockXeroConnector = {
      fullSync: jest.fn().mockResolvedValue({
        contactsUpserted: 5,
        invoicesUpserted: 10,
        paymentsUpserted: 2,
        recordsSkipped: 0,
        recordsFailed: 0,
        errors: [],
      }),
    };

    const mockConnectorFactory = {
      getConnector: jest.fn().mockReturnValue(mockXeroConnector),
    };

    mockConnectionModel = {
      findById: jest.fn().mockResolvedValue({
        _id: 'conn-1',
        orgId: 'org-1',
        provider: 'xero',
        isDeleted: false,
      }),
      updateOne: jest.fn(),
    };

    mockSyncLogModel = {
      updateOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncProcessor,
        { provide: ConnectorFactory, useValue: mockConnectorFactory },
        { provide: getModelToken(AccountingConnection.name), useValue: mockConnectionModel },
        { provide: getModelToken(SyncLog.name), useValue: mockSyncLogModel },
        { provide: CsvConnector, useValue: {} },
        { provide: AuditLoggerService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    processor = module.get<SyncProcessor>(SyncProcessor);
  });

  it('should process a full sync job successfully', async () => {
    const job: any = {
      id: 'job-1',
      data: {
        type: 'full_sync',
        connectionId: 'conn-1',
        orgId: 'org-1',
        triggeredBy: 'user-1',
        syncLogId: 'log-1',
      },
    };

    const result = await processor.process(job);

    expect(mockXeroConnector.fullSync).toHaveBeenCalled();
    expect(result.invoicesUpserted).toBe(10);
    expect(mockConnectionModel.updateOne).toHaveBeenCalledWith(
      { _id: 'conn-1' },
      expect.objectContaining({
        $inc: {
          totalInvoicesSynced: 10,
          totalContactsSynced: 5,
          totalPaymentsSynced: 2,
        },
      })
    );
  });
});
