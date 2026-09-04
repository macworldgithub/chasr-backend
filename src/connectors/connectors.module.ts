// src/connectors/connectors.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { XeroConnector } from './xero/xero.connector';
import { XeroOAuthService } from './xero/xero-oauth.service';
import { XeroWebhookHandler } from './xero/xero-webhook.handler';
import { QuickBooksWebhookHandler } from './quickbooks/quickbooks-webhook.handler';
import { MyobConnector } from './myob/myob.connector';
import { MyobOAuthService } from './myob/myob-oauth.service';
import { QuickBooksConnector } from './quickbooks/quickbooks.connector';
import { QuickBooksOAuthService } from './quickbooks/quickbooks-oauth.service';
import { CsvConnector } from './csv/csv.connector';
import { CsvMapperService } from './csv/csv-mapper.service';
import { ConnectorFactory } from './connector.factory';
import { SyncModule } from '../sync/sync.module';
import { AuditModule } from '../audit/audit.module';
import {
  AccountingConnection,
  AccountingConnectionSchema,
} from '../integrations/schemas/accounting-connection.schema';
import {
  SyncLog,
  SyncLogSchema,
} from '../integrations/schemas/sync-log.schema';
import { Invoice, InvoiceSchema } from '../integrations/schemas/invoice.schema';
import {
  XeroOrganisation,
  XeroOrganisationSchema,
} from '../integrations/schemas/xero-organisation.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AccountingConnection.name, schema: AccountingConnectionSchema },
      { name: SyncLog.name, schema: SyncLogSchema },
      { name: Invoice.name, schema: InvoiceSchema }, // Needed for CSV connector
      { name: XeroOrganisation.name, schema: XeroOrganisationSchema }, // Org info
    ]),
    BullModule.registerQueue({ name: 'accounting-sync' }),
    forwardRef(() => SyncModule), // DataMapperService is in SyncModule, which imports ConnectorsModule
    AuditModule,
  ],
  controllers: [XeroWebhookHandler, QuickBooksWebhookHandler],
  providers: [
    XeroConnector,
    XeroOAuthService,
    MyobConnector,
    MyobOAuthService,
    QuickBooksConnector,
    QuickBooksOAuthService,
    CsvConnector,
    CsvMapperService,
    ConnectorFactory,
  ],
  exports: [
    ConnectorFactory,
    CsvConnector,
    XeroOAuthService,
    MyobOAuthService,
    QuickBooksOAuthService,
    CsvMapperService, // Exported for unit tests
  ],
})
export class ConnectorsModule {}
