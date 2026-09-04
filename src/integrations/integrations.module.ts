// src/integrations/integrations.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { SyncModule } from '../sync/sync.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { AuditModule } from '../audit/audit.module';
import { OrgScopeGuard } from '../shared/guards/org-scope.guard';
import {
  AccountingConnection,
  AccountingConnectionSchema,
} from './schemas/accounting-connection.schema';
import { SyncLog, SyncLogSchema } from './schemas/sync-log.schema';
import {
  XeroOrganisation,
  XeroOrganisationSchema,
} from './schemas/xero-organisation.schema';

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const secret = configService.get<string>('JWT_SECRET');

        if (!secret) {
          throw new Error(
            'JWT_SECRET is not set. Add it to your environment or .env file.',
          );
        }

        return {
          global: true,
          secret,
          signOptions: { expiresIn: '1d' },
        };
      },
    }),
    MongooseModule.forFeature([
      { name: AccountingConnection.name, schema: AccountingConnectionSchema },
      { name: SyncLog.name, schema: SyncLogSchema },
      { name: XeroOrganisation.name, schema: XeroOrganisationSchema },
    ]),
    SyncModule,
    ConnectorsModule,
    AuditModule,
  ],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, OrgScopeGuard],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
