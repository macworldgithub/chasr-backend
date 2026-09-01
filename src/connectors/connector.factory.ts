// src/connectors/connector.factory.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { BaseConnector } from './base.connector';
import { XeroConnector } from './xero/xero.connector';
import { MyobConnector } from './myob/myob.connector';
import { QuickBooksConnector } from './quickbooks/quickbooks.connector';
import { Provider } from '../integrations/schemas/accounting-connection.schema';

/**
 * ConnectorFactory — resolves the correct connector by provider name.
 *
 * Adding a new provider (e.g. QuickBooks) in Phase 2:
 *   1. Create src/connectors/quickbooks/quickbooks.connector.ts
 *   2. Extend BaseConnector
 *   3. Add to the switch below
 *   4. Register in connectors.module.ts
 *
 * Zero changes needed to sync pipeline, scheduler, or storage layer.
 */
@Injectable()
export class ConnectorFactory {
  constructor(
    private readonly xeroConnector: XeroConnector,
    private readonly myobConnector: MyobConnector,
    private readonly quickBooksConnector: QuickBooksConnector,
  ) {}

  getConnector(provider: Provider | string): BaseConnector {
    switch (provider) {
      case 'xero':
        return this.xeroConnector;
      case 'myob':
        return this.myobConnector;
      case 'quickbooks':
        return this.quickBooksConnector;
      default:
        throw new NotFoundException(
          `No connector registered for provider: ${provider}`,
        );
    }
  }
}
