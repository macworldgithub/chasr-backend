// src/sync/sync.module.ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { SyncProcessor } from './sync.processor';
import { SyncOrchestratorService } from './sync-orchestrator.service';
import { SyncSchedulerService } from './sync-scheduler.service';
import { DataMapperService } from './data-mapper.service';
import { ConflictResolverService } from './conflict-resolver.service';
import { ChaseEngineService } from './chase-engine.service';
import { ConnectorsModule } from '../connectors/connectors.module';
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
import { Contact, ContactSchema } from '../integrations/schemas/contact.schema';
import { Payment, PaymentSchema } from '../integrations/schemas/payment.schema';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    BullModule.registerQueue({
      name: 'accounting-sync',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 30_000, // 30s → 60s → 120s
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    }),
    MongooseModule.forFeature([
      { name: AccountingConnection.name, schema: AccountingConnectionSchema },
      { name: SyncLog.name, schema: SyncLogSchema },
      { name: Invoice.name, schema: InvoiceSchema },
      { name: Contact.name, schema: ContactSchema },
      { name: Payment.name, schema: PaymentSchema },
    ]),
    ConnectorsModule,
    AuditModule,
  ],
  providers: [
    SyncProcessor,
    SyncOrchestratorService,
    SyncSchedulerService,
    DataMapperService,
    ConflictResolverService,
    ChaseEngineService,
  ],
  exports: [SyncOrchestratorService, DataMapperService],
})
export class SyncModule {}
