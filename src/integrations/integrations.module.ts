// src/integrations/integrations.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { SyncModule } from '../sync/sync.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { AuditModule } from '../audit/audit.module';
import {
  AccountingConnection,
  AccountingConnectionSchema,
} from './schemas/accounting-connection.schema';
import { SyncLog, SyncLogSchema } from './schemas/sync-log.schema';

@Module({
  imports: [
    JwtModule,
    MongooseModule.forFeature([
      { name: AccountingConnection.name, schema: AccountingConnectionSchema },
      { name: SyncLog.name, schema: SyncLogSchema },
    ]),
    SyncModule,
    ConnectorsModule,
    AuditModule,
  ],
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
