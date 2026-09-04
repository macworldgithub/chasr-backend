import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { DataMapperService } from '../../src/sync/data-mapper.service';
import { ChaseEngineService } from '../../src/sync/chase-engine.service';
import { Invoice } from '../../src/integrations/schemas/invoice.schema';
import { Contact } from '../../src/integrations/schemas/contact.schema';
import { Payment } from '../../src/integrations/schemas/payment.schema';

describe('DataMapperService', () => {
  let service: DataMapperService;
  let mockInvoiceModel: any;
  let mockContactModel: any;
  let mockPaymentModel: any;
  let mockChaseEngine: any;

  beforeEach(async () => {
    mockInvoiceModel = {
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn(),
    };
    mockContactModel = {
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn(),
    };
    mockPaymentModel = {
      findOneAndUpdate: jest.fn(),
    };
    mockChaseEngine = {
      haltChase: jest.fn(),
      enrollInChaseSequence: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataMapperService,
        {
          provide: getModelToken(Invoice.name),
          useValue: mockInvoiceModel,
        },
        {
          provide: getModelToken(Contact.name),
          useValue: mockContactModel,
        },
        {
          provide: getModelToken(Payment.name),
          useValue: mockPaymentModel,
        },
        {
          provide: ChaseEngineService,
          useValue: mockChaseEngine,
        },
      ],
    }).compile();

    service = module.get<DataMapperService>(DataMapperService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('upsertInvoice', () => {
    const orgId = new Types.ObjectId();

    it('should map and upsert a Xero invoice', async () => {
      const rawXeroInvoice = {
        invoiceID: 'xero-inv-1',
        invoiceNumber: 'INV-001',
        dueDate: '2026-02-01T00:00:00',
        total: 100,
        amountDue: 100,
        currencyCode: 'AUD',
        status: 'AUTHORISED',
        contact: { contactID: 'xero-contact-1' },
      };

      mockContactModel.findOne.mockResolvedValue({ _id: new Types.ObjectId() });

      const mockUpsertedInvoice = {
        _id: new Types.ObjectId(),
        status: 'AUTHORISED',
        balanceDue: 100,
        dueDate: new Date('2026-02-01T00:00:00'),
        chaseState: 'pending',
      };

      mockInvoiceModel.findOneAndUpdate.mockResolvedValue(mockUpsertedInvoice);

      await service.upsertInvoice(orgId, 'xero', rawXeroInvoice);

      expect(mockInvoiceModel.findOneAndUpdate).toHaveBeenCalledWith(
        { orgId, externalId: 'xero-inv-1', externalSource: 'xero' },
        expect.objectContaining({
          $set: expect.objectContaining({
            invoiceNumber: 'INV-001',
            status: 'AUTHORISED',
          }),
          $setOnInsert: expect.objectContaining({
            chaseState: 'pending',
          }),
        }),
        { upsert: true, new: true },
      );
    });

    it('should halt chase if invoice is PAID', async () => {
      const rawXeroInvoice = {
        invoiceID: 'xero-inv-1',
        invoiceNumber: 'INV-001',
        dueDate: '2026-02-01T00:00:00',
        total: 100,
        amountDue: 0,
        currencyCode: 'AUD',
        status: 'PAID',
      };

      const mockUpsertedInvoice = {
        _id: new Types.ObjectId(),
        status: 'PAID',
        balanceDue: 0,
        dueDate: new Date('2026-02-01T00:00:00'),
      };

      mockInvoiceModel.findOneAndUpdate.mockResolvedValue(mockUpsertedInvoice);

      await service.upsertInvoice(orgId, 'xero', rawXeroInvoice);

      expect(mockChaseEngine.haltChase).toHaveBeenCalledWith(
        mockUpsertedInvoice._id,
        'payment_received',
      );
    });

    it('should map and upsert a QuickBooks invoice', async () => {
      const rawQuickBooksInvoice = {
        Id: 'qb-inv-1',
        DocNumber: 'QB-1001',
        TxnDate: '2026-02-01',
        DueDate: '2026-02-15',
        TotalAmt: 245.5,
        Balance: 245.5,
        CurrencyRef: { value: 'AUD' },
        CustomerRef: { value: 'qb-customer-1' },
        PrivateNote: 'Finance',
      };

      mockContactModel.findOne.mockResolvedValue({ _id: new Types.ObjectId() });
      mockInvoiceModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(),
        status: 'OPEN',
        balanceDue: 245.5,
        dueDate: new Date('2026-02-15T00:00:00'),
      });

      await service.upsertInvoice(orgId, 'quickbooks', rawQuickBooksInvoice);

      expect(mockInvoiceModel.findOneAndUpdate).toHaveBeenCalledWith(
        { orgId, externalId: 'qb-inv-1', externalSource: 'quickbooks' },
        expect.objectContaining({
          $set: expect.objectContaining({
            invoiceNumber: 'QB-1001',
            total: 245.5,
            balanceDue: 245.5,
            currency: 'AUD',
          }),
        }),
        { upsert: true, new: true },
      );
    });

    it('should map and upsert a QuickBooks credit memo and evaluate chase', async () => {
      const rawCreditMemo = {
        Id: 'qb-cm-1',
        DocNumber: 'CM-001',
        TxnDate: '2026-02-10',
        TotalAmt: 100,
        RemainingCredit: 0,
        CustomerRef: { value: 'qb-customer-1' },
        Line: [
          {
            LinkedTxn: [{ TxnId: 'qb-inv-1', TxnType: 'Invoice' }],
          },
        ],
      };

      const mockLinkedInvoice = {
        _id: new Types.ObjectId(),
        orgId,
        status: 'PAID',
        balanceDue: 0,
        dueDate: new Date('2026-02-01'),
      };

      mockInvoiceModel.findOne.mockResolvedValue(mockLinkedInvoice);

      await service.upsertCreditMemo(orgId, 'quickbooks', rawCreditMemo);

      expect(mockInvoiceModel.findOne).toHaveBeenCalledWith({
        orgId,
        externalId: 'qb-inv-1',
        externalSource: 'quickbooks',
      });
      expect(mockChaseEngine.haltChase).toHaveBeenCalledWith(
        mockLinkedInvoice._id,
        'payment_received',
      );
    });
  });
});

