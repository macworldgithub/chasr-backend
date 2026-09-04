// src/sync/data-mapper.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Invoice } from '../integrations/schemas/invoice.schema';
import { Contact } from '../integrations/schemas/contact.schema';
import { Payment } from '../integrations/schemas/payment.schema';
import { XeroOrganisation } from '../integrations/schemas/xero-organisation.schema';
import { ChaseEngineService } from './chase-engine.service';

// ── Normalised intermediate types ─────────────────────────────────────────────

interface NormalisedContact {
  externalId: string;
  name: string;
  emails: string[];
  phones: string[];
  address: {
    street?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
  } | null;
  paymentTermsDays: number | null;
}

interface NormalisedInvoice {
  externalId: string;
  invoiceNumber: string;
  issueDate?: Date;
  dueDate: Date;
  total: number;
  balanceDue: number;
  currency: string;
  status: string;
  externalContactId: string | null;
  pdfUrl: string | null;
}

interface NormalisedPayment {
  externalId: string;
  date: Date;
  amount: number;
  currency: string;
  method: string;
  reference: string;
  allocatedExternalInvoiceIds: string[];
}

interface NormalisedCreditMemo {
  externalId: string;
  docNumber: string;
  date: Date;
  total: number;
  remainingCredit: number;
  currency: string;
  externalContactId: string | null;
  allocatedExternalInvoiceIds: string[];
}

// ── DataMapperService ─────────────────────────────────────────────────────────

/**
 * DataMapperService — the critical normalisation layer.
 *
 * Translates raw accounting system data (Xero/MYOB/CSV) into Chasr's internal model.
 *
 * KEY RULES (enforced here):
 * 1. All upserts are idempotent — key: (orgId, externalId, externalSource)
 * 2. Accounting system wins on ALL financial fields ($set)
 * 3. Chasr-owned fields (chaseState, lastChaseAt, chaseSequenceId) are set ONLY
 *    on first insert ($setOnInsert) and NEVER overwritten by sync
 * 4. Payment sync triggers chase halt when balanceDue <= 0 or status === PAID
 */
@Injectable()
export class DataMapperService {
  private readonly logger = new Logger(DataMapperService.name);

  constructor(
    @InjectModel(Invoice.name) private readonly invoiceModel: Model<Invoice>,
    @InjectModel(Contact.name) private readonly contactModel: Model<Contact>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(XeroOrganisation.name)
    private readonly xeroOrgModel: Model<XeroOrganisation>,
    private readonly chaseEngine: ChaseEngineService,
  ) {}

  // ── Contacts ──────────────────────────────────────────────────────────────

  async upsertContact(
    orgId: Types.ObjectId,
    source: string,
    raw: any,
  ): Promise<void> {
    const normalised = this.normaliseContact(source, raw);

    await this.contactModel.findOneAndUpdate(
      { orgId, externalId: normalised.externalId, externalSource: source },
      {
        $set: {
          // Accounting system fields — always overwrite
          name: normalised.name,
          emails: normalised.emails,
          phones: normalised.phones,
          address: normalised.address,
          paymentTermsDays: normalised.paymentTermsDays,
          lastSyncedAt: new Date(),
        },
        $setOnInsert: {
          // Chasr-owned — only set on first create
          orgId,
          externalId: normalised.externalId,
          externalSource: source,
          chaseState: 'active',
        },
      },
      { upsert: true, new: true },
    );
  }

  // ── Invoices ──────────────────────────────────────────────────────────────

  async upsertInvoice(
    orgId: Types.ObjectId,
    source: string,
    raw: any,
  ): Promise<void> {
    const normalised = this.normaliseInvoice(source, raw);

    // Resolve Chasr-internal contactId from the external contact ID
    const contact = normalised.externalContactId
      ? await this.contactModel.findOne({
          orgId,
          externalId: normalised.externalContactId,
          externalSource: source,
        })
      : null;

    const updated = await this.invoiceModel.findOneAndUpdate(
      { orgId, externalId: normalised.externalId, externalSource: source },
      {
        $set: {
          // Financial fields — accounting system is source of truth
          invoiceNumber: normalised.invoiceNumber,
          issueDate: normalised.issueDate,
          dueDate: normalised.dueDate,
          total: normalised.total,
          balanceDue: normalised.balanceDue,
          currency: normalised.currency,
          status: normalised.status,
          contactId: contact?._id ?? null,
          pdfUrl: normalised.pdfUrl,
          lastSyncedAt: new Date(),
          // NOTE: chaseState, lastChaseAt, chaseSequenceId are NEVER in $set
        },
        $setOnInsert: {
          // Chasr defaults — only on first create
          orgId,
          externalId: normalised.externalId,
          externalSource: source,
          chaseState: 'pending',
        },
      },
      { upsert: true, new: true },
    );

    // After upsert: evaluate chase enrollment (most business-critical behaviour)
    if (updated) {
      await this.evaluateChaseEnrollment(updated);
    }
  }

  // ── Organisation ──────────────────────────────────────────────────────────

  /**
   * Upsert the Xero organisation details for a connection.
   * Called once on fullSync — keeps org name, currency, country up to date.
   */
  async upsertOrganisation(
    connectionId: Types.ObjectId,
    orgId: Types.ObjectId,
    raw: any,
  ): Promise<void> {
    // Xero returns organisation fields at top level of each org object
    await this.xeroOrgModel.findOneAndUpdate(
      { connectionId },
      {
        $set: {
          orgId,
          connectionId,
          name: raw.name,
          legalName: raw.legalName,
          taxNumber: raw.taxNumber,
          baseCurrency: raw.baseCurrency,
          countryCode: raw.countryCode,
          timezone: raw.timezone,
          shortCode: raw.shortCode,
          xeroOrgId: raw.organisationID,
          organisationType: raw.organisationType,
          financialYearEndMonth: raw.financialYearEndMonth,
          lastSyncedAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );
  }

  // ── Payments ──────────────────────────────────────────────────────────────

  async upsertPayment(
    orgId: Types.ObjectId,
    source: string,
    raw: any,
  ): Promise<void> {
    const normalised = this.normalisePayment(source, raw);

    await this.paymentModel.findOneAndUpdate(
      { orgId, externalId: normalised.externalId, externalSource: source },
      {
        $set: {
          date: normalised.date,
          amount: normalised.amount,
          currency: normalised.currency,
          method: normalised.method,
          reference: normalised.reference,
          lastSyncedAt: new Date(),
        },
        $setOnInsert: {
          orgId,
          externalId: normalised.externalId,
          externalSource: source,
        },
      },
      { upsert: true, new: true },
    );

    // Reconcile payment to invoices — update balanceDue and trigger chase halt
    if (normalised.allocatedExternalInvoiceIds.length > 0) {
      await this.reconcilePaymentToInvoices(orgId, source, normalised);
    }
  }

  // ── Credit Memos ──────────────────────────────────────────────────────────

  async upsertCreditMemo(
    orgId: Types.ObjectId,
    source: string,
    raw: any,
  ): Promise<void> {
    const normalised = this.normaliseCreditMemo(source, raw);

    // If credit memo links to specific invoices, reconcile them (adjust balance / halt chase)
    if (normalised.allocatedExternalInvoiceIds.length > 0) {
      await this.reconcileCreditMemoToInvoices(orgId, source, normalised);
    }
  }

  // ── Normalisation — Xero ──────────────────────────────────────────────────

  private normaliseContactXero(raw: any): NormalisedContact {
    return {
      externalId: raw.contactID,
      name: raw.name,
      emails: raw.emailAddress ? [raw.emailAddress] : [],
      phones: (raw.phones ?? [])
        .map((p: any) =>
          `${p.phoneAreaCode ?? ''}${p.phoneNumber ?? ''}`.trim(),
        )
        .filter(Boolean),
      address: raw.addresses?.[0]
        ? {
            street: raw.addresses[0].addressLine1,
            city: raw.addresses[0].city,
            state: raw.addresses[0].region,
            postcode: raw.addresses[0].postalCode,
            country: raw.addresses[0].country ?? 'Australia',
          }
        : null,
      paymentTermsDays: raw.paymentTerms?.sales?.day ?? null,
    };
  }

  private normaliseInvoiceXero(raw: any): NormalisedInvoice {
    return {
      externalId: raw.invoiceID,
      invoiceNumber: raw.invoiceNumber,
      issueDate: raw.date ? new Date(raw.date) : undefined,
      dueDate: new Date(raw.dueDate),
      total: raw.total ?? 0,
      balanceDue: raw.amountDue ?? 0,
      currency: raw.currencyCode ?? 'AUD',
      status: raw.status, // DRAFT|AUTHORISED|PAID|VOIDED
      externalContactId: raw.contact?.contactID ?? null,
      // onlineInvoiceUrl is the shareable link (e.g. https://go.xero.com/...)
      // Fall back to raw.url for older Xero editions that don't return onlineInvoiceUrl
      pdfUrl: raw.onlineInvoiceUrl ?? raw.url ?? null,
    };
  }

  private normalisePaymentXero(raw: any): NormalisedPayment {
    return {
      externalId: raw.paymentID,
      date: new Date(raw.date),
      amount: raw.amount ?? 0,
      currency: raw.currencyRate ? 'AUD' : 'AUD',
      method: raw.paymentType ?? 'BANK',
      reference: raw.reference ?? '',
      allocatedExternalInvoiceIds: raw.invoice?.invoiceID
        ? [raw.invoice.invoiceID]
        : [],
    };
  }

  // ── Normalisation — MYOB ──────────────────────────────────────────────────

  private normaliseContactMyob(raw: any): NormalisedContact {
    const name =
      `${raw.FirstName ?? ''} ${raw.LastName ?? ''}`.trim() ||
      raw.CompanyName ||
      'Unknown';

    return {
      externalId: raw.UID,
      name,
      emails: raw.Addresses?.map((a: any) => a.Email).filter(Boolean) ?? [],
      phones: raw.Addresses?.map((a: any) => a.Phone1).filter(Boolean) ?? [],
      address: raw.Addresses?.[0]
        ? {
            street: raw.Addresses[0].Street,
            city: raw.Addresses[0].City,
            state: raw.Addresses[0].State,
            postcode: raw.Addresses[0].PostCode,
            country: raw.Addresses[0].Country ?? 'Australia',
          }
        : null,
      paymentTermsDays: raw.PaymentIsDue?.Days ?? null,
    };
  }

  private normaliseInvoiceMyob(raw: any): NormalisedInvoice {
    return {
      externalId: raw.UID,
      invoiceNumber: raw.Number,
      issueDate: this.parseMYOBDate(raw.Date) ?? undefined,
      dueDate: this.parseMYOBDate(raw.TermsPaymentIsDueDate) ?? new Date(),
      total: raw.TotalAmount ?? 0,
      balanceDue: raw.BalanceDueAmount ?? 0,
      currency: 'AUD',
      status: raw.Status ?? 'AUTHORISED',
      externalContactId: raw.Customer?.UID ?? null,
      pdfUrl: null,
    };
  }

  private normalisePaymentMyob(raw: any): NormalisedPayment {
    return {
      externalId: raw.UID,
      date: this.parseMYOBDate(raw.Date) ?? new Date(),
      amount: raw.TotalAmount ?? 0,
      currency: 'AUD',
      method: raw.PaymentMethod ?? 'BANK',
      reference: raw.Memo ?? '',
      allocatedExternalInvoiceIds:
        raw.Lines?.map((l: any) => l.Sale?.UID).filter(Boolean) ?? [],
    };
  }

  // ── Normalisation — QuickBooks ────────────────────────────────────────────

  private normaliseContactQuickBooks(raw: any): NormalisedContact {
    const primaryEmail =
      raw.PrimaryEmailAddr?.Address ?? raw.PrimaryPhone?.FreeFormNumber ?? null;
    const phone =
      raw.PrimaryPhone?.FreeFormNumber ?? raw.Mobile?.FreeFormNumber ?? null;

    return {
      externalId: raw.Id,
      name: raw.DisplayName || raw.CompanyName || 'QuickBooks Customer',
      emails: primaryEmail ? [primaryEmail] : [],
      phones: phone ? [phone] : [],
      address: raw.BillAddr
        ? {
            street: raw.BillAddr.Line1 ?? undefined,
            city: raw.BillAddr.City ?? undefined,
            state: raw.BillAddr.CountrySubDivisionCode ?? undefined,
            postcode: raw.BillAddr.PostalCode ?? undefined,
            country: raw.BillAddr.Country ?? 'Australia',
          }
        : null,
      paymentTermsDays: raw.TermsRef?.value ? Number(raw.TermsRef.value) : null,
    };
  }

  private normaliseInvoiceQuickBooks(raw: any): NormalisedInvoice {
    return {
      externalId: raw.Id,
      invoiceNumber: raw.DocNumber ?? raw.Id,
      issueDate: raw.TxnDate ? new Date(raw.TxnDate) : undefined,
      dueDate: raw.DueDate ? new Date(raw.DueDate) : new Date(),
      total: raw.TotalAmt ?? 0,
      balanceDue: raw.Balance ?? raw.TotalAmt ?? 0,
      currency: raw.CurrencyRef?.value ?? 'AUD',
      status: this.mapQuickBooksInvoiceStatus(raw),
      externalContactId: raw.CustomerRef?.value ?? null,
      pdfUrl: raw.PrivateNote ?? null,
    };
  }

  private normalisePaymentQuickBooks(raw: any): NormalisedPayment {
    return {
      externalId: raw.Id,
      date: raw.TxnDate ? new Date(raw.TxnDate) : new Date(),
      amount: raw.TotalAmt ?? 0,
      currency: raw.CurrencyRef?.value ?? 'AUD',
      method: raw.PaymentMethodRef?.name ?? 'BANK',
      reference: raw.PrivateNote ?? raw.PaymentRefNum ?? '',
      allocatedExternalInvoiceIds:
        raw.Line?.map((line: any) => line.LinkedTxn?.[0]?.TxnId).filter(
          Boolean,
        ) ?? [],
    };
  }

  private normaliseCreditMemoQuickBooks(raw: any): NormalisedCreditMemo {
    return {
      externalId: raw.Id,
      docNumber: raw.DocNumber ?? raw.Id,
      date: raw.TxnDate ? new Date(raw.TxnDate) : new Date(),
      total: raw.TotalAmt ?? 0,
      remainingCredit: raw.RemainingCredit ?? 0,
      currency: raw.CurrencyRef?.value ?? 'AUD',
      externalContactId: raw.CustomerRef?.value ?? null,
      allocatedExternalInvoiceIds:
        raw.Line?.flatMap((line: any) =>
          (line.LinkedTxn ?? [])
            .filter((txn: any) => txn.TxnType === 'Invoice')
            .map((txn: any) => txn.TxnId),
        ).filter(Boolean) ?? [],
    };
  }

  // ── Normalisation — CSV ───────────────────────────────────────────────────
  // CSV rows are already normalised by CsvMapperService, passed through as-is.

  private normaliseContactCsv(raw: any): NormalisedContact {
    return raw as NormalisedContact;
  }

  private normaliseInvoiceCsv(raw: any): NormalisedInvoice {
    return raw as NormalisedInvoice;
  }

  private normalisePaymentCsv(raw: any): NormalisedPayment {
    return raw as NormalisedPayment;
  }

  // ── Dispatch helpers ──────────────────────────────────────────────────────

  private normaliseContact(source: string, raw: any): NormalisedContact {
    if (source === 'xero') return this.normaliseContactXero(raw);
    if (source === 'myob') return this.normaliseContactMyob(raw);
    if (source === 'quickbooks') return this.normaliseContactQuickBooks(raw);
    if (source === 'csv') return this.normaliseContactCsv(raw);
    throw new Error(`Unknown source: ${source}`);
  }

  private normaliseInvoice(source: string, raw: any): NormalisedInvoice {
    if (source === 'xero') return this.normaliseInvoiceXero(raw);
    if (source === 'myob') return this.normaliseInvoiceMyob(raw);
    if (source === 'quickbooks') return this.normaliseInvoiceQuickBooks(raw);
    if (source === 'csv') return this.normaliseInvoiceCsv(raw);
    throw new Error(`Unknown source: ${source}`);
  }

  private normalisePayment(source: string, raw: any): NormalisedPayment {
    if (source === 'xero') return this.normalisePaymentXero(raw);
    if (source === 'myob') return this.normalisePaymentMyob(raw);
    if (source === 'quickbooks') return this.normalisePaymentQuickBooks(raw);
    if (source === 'csv') return this.normalisePaymentCsv(raw);
    throw new Error(`Unknown source: ${source}`);
  }

  private normaliseCreditMemo(source: string, raw: any): NormalisedCreditMemo {
    if (source === 'quickbooks') return this.normaliseCreditMemoQuickBooks(raw);
    throw new Error(`Credit memo normalization not supported for source: ${source}`);
  }

  // ── Chase engine integration (most business-critical logic) ───────────────

  /**
   * After every invoice upsert:
   *   - PAID or balanceDue=0 → halt chase
   *   - Overdue + pending → auto-enroll in chase sequence
   */
  private async evaluateChaseEnrollment(invoice: Invoice): Promise<void> {
    // Payment received — halt chase immediately
    if (invoice.status === 'PAID' || invoice.balanceDue <= 0) {
      await this.chaseEngine.haltChase(
        invoice._id as Types.ObjectId,
        'payment_received',
      );
      return;
    }

    // Voided — halt chase
    if (invoice.status === 'VOIDED') {
      await this.chaseEngine.haltChase(
        invoice._id as Types.ObjectId,
        'invoice_voided',
      );
      return;
    }

    // Overdue and not yet chasing — auto-enroll
    const isOverdue = invoice.dueDate < new Date();
    if (isOverdue && invoice.chaseState === 'pending') {
      await this.chaseEngine.enrollInChaseSequence(
        invoice._id as Types.ObjectId,
        invoice.orgId,
      );
    }
  }

  private async reconcilePaymentToInvoices(
    orgId: Types.ObjectId,
    source: string,
    payment: NormalisedPayment,
  ): Promise<void> {
    for (const externalInvoiceId of payment.allocatedExternalInvoiceIds) {
      const invoice = await this.invoiceModel.findOne({
        orgId,
        externalId: externalInvoiceId,
        externalSource: source,
      });

      if (!invoice) continue;

      // Add payment to invoice's allocatedInvoiceIds and re-evaluate chase
      await this.evaluateChaseEnrollment(invoice);
    }
  }

  private async reconcileCreditMemoToInvoices(
    orgId: Types.ObjectId,
    source: string,
    creditMemo: NormalisedCreditMemo,
  ): Promise<void> {
    for (const externalInvoiceId of creditMemo.allocatedExternalInvoiceIds) {
      const invoice = await this.invoiceModel.findOne({
        orgId,
        externalId: externalInvoiceId,
        externalSource: source,
      });

      if (!invoice) continue;

      // Re-evaluate chase state (halt chase if balance reduced to 0 or paid)
      await this.evaluateChaseEnrollment(invoice);
    }
  }

  // ── Date parsing ──────────────────────────────────────────────────────────

  /**
   * MYOB date format: /Date(milliseconds+offset)/
   * e.g. /Date(1234567890000+1000)/
   */
  private parseMYOBDate(myobDate: string | undefined): Date | null {
    if (!myobDate) return null;
    const match = myobDate.match(/\/Date\((\d+)/);
    return match ? new Date(parseInt(match[1], 10)) : null;
  }

  private mapQuickBooksInvoiceStatus(raw: any): string {
    const total = Number(raw.TotalAmt ?? 0);
    const balance = Number(raw.Balance ?? raw.TotalAmt ?? 0);

    if (raw.PrivateNote === 'VOID' || (raw.Balance === 0 && raw.TotalAmt === 0))
      return 'VOIDED';
    if (balance <= 0 || raw.Balance === 0) return 'PAID';
    if (total > 0 && balance > 0) return 'AUTHORISED';
    return 'OPEN';
  }
}
