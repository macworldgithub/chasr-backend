// src/connectors/csv/csv.connector.ts
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseCSV } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { CsvMapperService, ColumnMapping, NormalisedInvoiceCSV } from './csv-mapper.service';
import { DataMapperService } from '../../sync/data-mapper.service';
import { SyncResult } from '../base.connector';
import { Invoice } from '../../integrations/schemas/invoice.schema';

export interface CsvUploadSession {
  uploadId: string;
  orgId: string;
  filePath: string;
  detectedColumns: string[];
  suggestedMappings: ColumnMapping[];
  sampleRows: Record<string, string>[];
  totalRows: number;
  provider?: string;
}

/** In-memory upload sessions (use Redis in production for multi-instance) */
const uploadSessions = new Map<string, CsvUploadSession>();

@Injectable()
export class CsvConnector {
  private readonly logger = new Logger(CsvConnector.name);
  private readonly tempDir: string;

  constructor(
    private readonly csvMapper: CsvMapperService,
    private readonly dataMapper: DataMapperService,
    @InjectModel(Invoice.name)
    private readonly invoiceModel: Model<Invoice>,
  ) {
    this.tempDir = process.env.CSV_TEMP_STORAGE_PATH ?? './tmp/chasr-csv';
    fs.mkdirSync(this.tempDir, { recursive: true });
  }

  /**
   * Stage 1: Receive uploaded file, parse headers, return column detection.
   */
  async stageUpload(
    orgId: string,
    filePath: string,
    originalName: string,
    provider?: string,
  ): Promise<CsvUploadSession> {
    const rows = this.parseFile(filePath);

    if (rows.length === 0) {
      throw new BadRequestException('The uploaded file contains no data rows.');
    }

    const headers = Object.keys(rows[0]);
    const suggestedMappings = this.csvMapper.detectMappings(headers, provider);
    const sampleRows = rows.slice(0, 5); // First 5 rows for preview

    const uploadId = `csv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const session: CsvUploadSession = {
      uploadId,
      orgId,
      filePath,
      detectedColumns: headers,
      suggestedMappings,
      sampleRows,
      totalRows: rows.length,
      provider,
    };

    uploadSessions.set(uploadId, session);

    this.logger.log(
      `CSV upload staged: uploadId=${uploadId}, rows=${rows.length}, file=${originalName}`,
    );

    return session;
  }

  /**
   * Stage 2: Validate rows against user-confirmed mappings.
   * Returns validation report without committing any data.
   */
  async validateMappings(
    uploadId: string,
    mappings: ColumnMapping[],
  ): Promise<{
    valid: NormalisedInvoiceCSV[];
    errors: Array<{ row: number; field: string; message: string }>;
    totalRows: number;
    validRows: number;
    errorRows: number;
  }> {
    const session = this.getSession(uploadId);
    const rows = this.parseFile(session.filePath);
    const orgId = new Types.ObjectId(session.orgId);

    const missingRequired = this.csvMapper.getMissingRequiredFields(mappings);
    if (missingRequired.length > 0) {
      throw new BadRequestException(
        `Mapping is missing required fields: ${missingRequired.join(', ')}`,
      );
    }

    const { valid, errors } = await this.csvMapper.validateAndNormalise(
      rows,
      mappings,
      orgId,
    );

    return {
      valid,
      errors,
      totalRows: rows.length,
      validRows: valid.length,
      errorRows: errors.length,
    };
  }

  /**
   * Stage 3: Commit validated rows to the database.
   * Only call after validateMappings confirms data quality.
   */
  async commitUpload(
    uploadId: string,
    mappings: ColumnMapping[],
  ): Promise<SyncResult> {
    const session = this.getSession(uploadId);
    const rows = this.parseFile(session.filePath);
    const orgId = new Types.ObjectId(session.orgId);

    const { valid, errors } = await this.csvMapper.validateAndNormalise(
      rows,
      mappings,
      orgId,
    );

    const result: SyncResult = {
      contactsUpserted: 0,
      invoicesUpserted: 0,
      paymentsUpserted: 0,
      recordsSkipped: 0,
      recordsFailed: errors.length,
      errors: errors.map((e) => `Row ${e.row}: ${e.message}`),
    };

    for (const row of valid) {
      try {
        // Upsert contact from invoice row data
        if (row.contactName) {
          await this.dataMapper.upsertContact(orgId, 'csv', {
            externalId: row.contactName.toLowerCase().replace(/\s+/g, '-'),
            name: row.contactName,
            emails: row.contactEmail ? [row.contactEmail] : [],
            phones: row.contactPhone ? [row.contactPhone] : [],
            address: null,
            paymentTermsDays: null,
          });
          result.contactsUpserted++;
        }

        // Upsert invoice
        await this.dataMapper.upsertInvoice(orgId, 'csv', {
          externalId: row.externalId ?? row.invoiceNumber,
          invoiceNumber: row.invoiceNumber,
          issueDate: row.issueDate,
          dueDate: row.dueDate,
          total: row.total,
          balanceDue: row.balanceDue,
          currency: row.currency ?? 'AUD',
          status: row.status ?? 'AUTHORISED',
          externalContactId: row.contactName.toLowerCase().replace(/\s+/g, '-'),
          pdfUrl: row.invoicePdfUrl ?? null,
        });
        result.invoicesUpserted++;
      } catch (err) {
        result.errors.push(`Invoice ${row.invoiceNumber}: ${err.message}`);
        result.recordsFailed++;
      }
    }

    // Cleanup: delete temp file after successful commit
    this.cleanupSession(uploadId);

    this.logger.log(
      `CSV commit complete: uploadId=${uploadId}, invoices=${result.invoicesUpserted}, errors=${result.recordsFailed}`,
    );

    return result;
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private parseFile(filePath: string): Record<string, string>[] {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.csv') {
      const content = fs.readFileSync(filePath, 'utf-8');
      return parseCSV(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      }) as Record<string, string>[];
    }

    if (ext === '.xlsx' || ext === '.xls') {
      const workbook = XLSX.readFile(filePath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      return XLSX.utils.sheet_to_json<Record<string, string>>(sheet, {
        defval: '',
        raw: false,
      });
    }

    throw new BadRequestException(
      `Unsupported file type: ${ext}. Please upload a .csv or .xlsx file.`,
    );
  }

  private getSession(uploadId: string): CsvUploadSession {
    const session = uploadSessions.get(uploadId);
    if (!session) {
      throw new BadRequestException(
        `Upload session not found or expired: ${uploadId}. Please re-upload the file.`,
      );
    }
    return session;
  }

  private cleanupSession(uploadId: string): void {
    const session = uploadSessions.get(uploadId);
    if (session) {
      try {
        fs.unlinkSync(session.filePath);
      } catch {
        this.logger.warn(`Failed to delete temp file: ${session.filePath}`);
      }
      uploadSessions.delete(uploadId);
    }
  }
}
