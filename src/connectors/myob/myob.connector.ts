// src/connectors/myob/myob.connector.ts
import { Injectable, Logger, NotImplementedException } from '@nestjs/common';
import { BaseConnector, SyncResult } from '../base.connector';
import { AccountingConnection } from '../../integrations/schemas/accounting-connection.schema';

/**
 * MYOB Connector — Phase 1 skeleton.
 *
 * Phase 2 implementation guide:
 *
 * API base: https://api.myob.com/accountright/
 * Pagination: OData-style ?$top=200&$skip=N
 * Auth: Bearer token (OAuth cloud) or x-myobapi-key header (desktop)
 *
 * Key endpoints:
 *   GET /Contact/Customer        — customer contacts
 *   GET /Sale/Invoice/Service    — service invoices (AR)
 *   GET /Sale/Invoice/Item       — item-based invoices
 *   GET /Sale/CustomerPayment    — customer payments
 *
 * Date format: /Date(milliseconds+offset)/
 *   Parse: const match = myobDate.match(/\/Date\((\d+)/);
 *          return new Date(parseInt(match[1]));
 */
@Injectable()
export class MyobConnector extends BaseConnector {
  private readonly logger = new Logger(MyobConnector.name);

  async fullSync(connection: AccountingConnection): Promise<SyncResult> {
    throw new NotImplementedException(
      'MYOB connector coming in Phase 2. Please use CSV import as the fallback.',
    );
  }

  async incrementalSync(connection: AccountingConnection): Promise<SyncResult> {
    throw new NotImplementedException('MYOB connector coming in Phase 2.');
  }

  async processWebhookEvent(
    connection: AccountingConnection,
    webhookPayload: any,
  ): Promise<SyncResult> {
    throw new NotImplementedException('MYOB connector coming in Phase 2.');
  }

  async refreshTokensIfNeeded(
    connection: AccountingConnection,
  ): Promise<AccountingConnection> {
    throw new NotImplementedException('MYOB connector coming in Phase 2.');
  }

  async validateConnection(connection: AccountingConnection): Promise<boolean> {
    return false; // Phase 1: MYOB connections always fail validation
  }

  async revokeAccess(connection: AccountingConnection): Promise<void> {
    this.logger.warn(
      `MYOB revocation not yet implemented for connection ${connection._id}`,
    );
  }
}
