// src/connectors/csv/csv-mapper.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Invoice } from '../../integrations/schemas/invoice.schema';

export interface ColumnMapping {
  sourceColumn: string; // Column header from the uploaded CSV
  targetField: string;  // Chasr internal field name
}

export interface ValidationError {
  row: number;
  field: string;
  message: string;
}

export interface NormalisedInvoiceCSV {
  invoiceNumber: string;
  issueDate?: Date;
  dueDate: Date;
  total: number;
  balanceDue: number;
  status?: string;
  currency?: string;
  contactName: string;
  contactEmail?: string;
  contactPhone?: string;
  invoicePdfUrl?: string;
  reference?: string;
  externalId?: string;
}

/** All fields that must be present before a CSV commit is allowed */
const REQUIRED_FIELDS = [
  'invoiceNumber',
  'dueDate',
  'total',
  'balanceDue',
  'contactName',
];

/** Per-provider column name → Chasr field mappings */
const COLUMN_SUGGESTIONS: Record<string, Record<string, string>> = {
  xero: {
    'Invoice Number': 'invoiceNumber',
    'Invoice Date': 'issueDate',
    'Due Date': 'dueDate',
    'Total': 'total',
    'Amount Due': 'balanceDue',
    'To': 'contactName',
    'Email': 'contactEmail',
    'Reference': 'reference',
    'Status': 'status',
    'Currency': 'currency',
  },
  myob: {
    'Invoice No.': 'invoiceNumber',
    'Date': 'issueDate',
    'Due Date': 'dueDate',
    'Total Incl Tax': 'total',
    'Balance Due': 'balanceDue',
    'Customer Name': 'contactName',
    'Customer Email': 'contactEmail',
    'Reference': 'reference',
  },
  quickbooks: {
    'Invoice No': 'invoiceNumber',
    'Invoice Date': 'issueDate',
    'Due Date': 'dueDate',
    'Customer': 'contactName',
    'Amount': 'total',
    'Open Balance': 'balanceDue',
    'Email': 'contactEmail',
  },
  generic: {
    'Invoice #': 'invoiceNumber',
    'Invoice Number': 'invoiceNumber',
    'Invoice No': 'invoiceNumber',
    'Date': 'issueDate',
    'Due Date': 'dueDate',
    'Amount': 'total',
    'Total': 'total',
    'Balance': 'balanceDue',
    'Balance Due': 'balanceDue',
    'Amount Due': 'balanceDue',
    'Customer': 'contactName',
    'Customer Name': 'contactName',
    'Client': 'contactName',
    'Client Name': 'contactName',
    'Email': 'contactEmail',
    'Reference': 'reference',
    'Ref': 'reference',
    'Currency': 'currency',
  },
};

@Injectable()
export class CsvMapperService {
  constructor(
    @InjectModel(Invoice.name)
    private readonly invoiceModel: Model<Invoice>,
  ) {}

  /**
   * Detect Chasr field mappings from CSV headers.
   * Tries exact match first, then fuzzy match.
   */
  detectMappings(
    headers: string[],
    provider?: string,
  ): ColumnMapping[] {
    const suggestions = {
      ...COLUMN_SUGGESTIONS['generic'],
      ...(provider ? COLUMN_SUGGESTIONS[provider] ?? {} : {}),
    };

    const mappings: ColumnMapping[] = [];

    for (const col of headers) {
      // Exact match
      if (suggestions[col]) {
        mappings.push({ sourceColumn: col, targetField: suggestions[col] });
        continue;
      }

      // Fuzzy match (normalise to lowercase alphanumeric)
      const fuzzy = this.fuzzyMatch(col, suggestions);
      if (fuzzy) {
        mappings.push({ sourceColumn: col, targetField: fuzzy });
      }
    }

    return mappings;
  }

  /**
   * Validate and normalise CSV rows against a set of column mappings.
   * Returns separate arrays for valid rows and validation errors.
   */
  async validateAndNormalise(
    rows: Record<string, string>[],
    mappings: ColumnMapping[],
    orgId: Types.ObjectId,
  ): Promise<{ valid: NormalisedInvoiceCSV[]; errors: ValidationError[] }> {
    const valid: NormalisedInvoiceCSV[] = [];
    const errors: ValidationError[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // Row 1 is headers; rows start at 2 for user display
      const rowErrors: string[] = [];
      const mapped: Record<string, any> = {};

      // Apply column mappings
      for (const { sourceColumn, targetField } of mappings) {
        const val = row[sourceColumn]?.trim();
        if (val !== undefined && val !== '') {
          mapped[targetField] = val;
        }
      }

      // Validate required fields
      for (const field of REQUIRED_FIELDS) {
        if (!mapped[field]) {
          rowErrors.push(`Missing required field: ${field}`);
        }
      }

      // Normalise dates (AU: DD/MM/YYYY or ISO: YYYY-MM-DD)
      if (mapped['dueDate']) {
        const parsed = this.parseAUDate(mapped['dueDate']);
        if (!parsed) {
          rowErrors.push(`Invalid dueDate format: "${mapped['dueDate']}" (expected DD/MM/YYYY or YYYY-MM-DD)`);
        } else {
          mapped['dueDate'] = parsed;
        }
      }

      if (mapped['issueDate']) {
        const parsed = this.parseAUDate(mapped['issueDate']);
        mapped['issueDate'] = parsed ?? undefined;
      }

      // Normalise currency amounts (strip $, commas, whitespace)
      for (const amountField of ['total', 'balanceDue']) {
        if (mapped[amountField] !== undefined) {
          const cleaned = String(mapped[amountField]).replace(/[$,\s]/g, '');
          const num = parseFloat(cleaned);
          if (isNaN(num)) {
            rowErrors.push(`Invalid ${amountField}: "${mapped[amountField]}"`);
          } else {
            mapped[amountField] = num;
          }
        }
      }

      // Normalise status to Chasr internal format
      if (mapped['status']) {
        mapped['status'] = this.normaliseStatus(mapped['status']);
      }

      // Default currency to AUD if not specified
      if (!mapped['currency']) {
        mapped['currency'] = 'AUD';
      }

      if (rowErrors.length > 0) {
        errors.push({ row: rowNum, field: '', message: rowErrors.join('; ') });
      } else {
        valid.push(mapped as NormalisedInvoiceCSV);
      }
    }

    return { valid, errors };
  }

  /**
   * Check which mappings cover the required fields.
   */
  getMissingRequiredFields(mappings: ColumnMapping[]): string[] {
    const coveredFields = new Set(mappings.map((m) => m.targetField));
    return REQUIRED_FIELDS.filter((f) => !coveredFields.has(f));
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private fuzzyMatch(
    col: string,
    suggestions: Record<string, string>,
  ): string | null {
    const normalised = col.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const [key, value] of Object.entries(suggestions)) {
      const normKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normKey === normalised || normKey.includes(normalised) || normalised.includes(normKey)) {
        return value;
      }
    }
    return null;
  }

  /**
   * Parse Australian date formats:
   *   DD/MM/YYYY (most common from AU accounting apps)
   *   YYYY-MM-DD (ISO)
   *   DD-MM-YYYY
   */
  parseAUDate(val: string): Date | null {
    if (!val) return null;

    // DD/MM/YYYY
    const auSlash = val.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (auSlash) {
      const [, d, m, y] = auSlash;
      return new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
    }

    // DD-MM-YYYY
    const auDash = val.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (auDash) {
      const [, d, m, y] = auDash;
      return new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
    }

    // YYYY-MM-DD (ISO)
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      return new Date(val);
    }

    return null;
  }

  private normaliseStatus(raw: string): string {
    const upper = raw.toUpperCase().trim();
    const map: Record<string, string> = {
      'PAID': 'PAID',
      'OUTSTANDING': 'AUTHORISED',
      'AUTHORISED': 'AUTHORISED',
      'APPROVED': 'AUTHORISED',
      'OPEN': 'AUTHORISED',
      'UNPAID': 'AUTHORISED',
      'DRAFT': 'DRAFT',
      'VOID': 'VOIDED',
      'VOIDED': 'VOIDED',
      'OVERDUE': 'OVERDUE',
    };
    return map[upper] ?? 'AUTHORISED';
  }
}
