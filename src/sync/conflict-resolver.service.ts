// src/sync/conflict-resolver.service.ts
import { Injectable } from '@nestjs/common';

/**
 * ConflictResolverService — determines which field values win when
 * the accounting system and Chasr have conflicting data.
 *
 * Resolution rules (in priority order):
 *
 * 1. ACCOUNTING SYSTEM WINS on all financial fields:
 *    - invoiceNumber, issueDate, dueDate, total, balanceDue, currency, status, pdfUrl
 *    - contactName, contactEmail, contactPhone, address, paymentTermsDays
 *    - payment date, amount, method, reference
 *
 * 2. CHASR WINS (never overwritten) on all chase lifecycle fields:
 *    - chaseState, lastChaseAt, chaseSequenceId, chaseSequence
 *
 * 3. NEWEST WINS for lastSyncedAt — always the current timestamp.
 *
 * This service provides utility methods to enforce these rules.
 * The actual enforcement happens in DataMapperService via $set/$s.0etOnInsert.
 */
@Injectable()
export class ConflictResolverService {
  /**
   * Fields controlled by the accounting system — always overwritten by sync.
   * These must ONLY appear in $set in DataMapper upserts.
   */
  readonly accountingSystemFields = [
    'invoiceNumber',
    'issueDate',
    'dueDate',
    'total',
    'balanceDue',
    'currency',
    'status',
    'pdfUrl',
    'contactId',
    'name',
    'emails',
    'phones',
    'address',
    'paymentTermsDays',
    'date',
    'amount',
    'method',
    'reference',
    'lastSyncedAt',
  ] as const;

  /**
   * Fields owned by Chasr — NEVER overwritten by sync.
   * These must ONLY appear in $setOnInsert in DataMapper upserts.
   */
  readonly chasrOwnedFields = [
    'chaseState',
    'lastChaseAt',
    'chaseSequenceId',
  ] as const;

  /**
   * Validate that a sync $set update does not attempt to overwrite Chasr-owned fields.
   * Call this in tests to verify DataMapper is behaving correctly.
   */
  validateSyncUpdate(setFields: Record<string, any>): {
    valid: boolean;
    violations: string[];
  } {
    const violations = Object.keys(setFields).filter((k) =>
      (this.chasrOwnedFields as readonly string[]).includes(k),
    );
    return { valid: violations.length === 0, violations };
  }
}
