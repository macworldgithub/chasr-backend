// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { VaultModule } from './credential-vault/vault.module';
import { AuditModule } from './audit/audit.module';
import { SyncModule } from './sync/sync.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { InviteModule } from './invite/invite.module';

@Module({
  imports: [
    // Environment config
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    // JWT setup for the OrgScopeGuard
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
    }),
    // MongoDB connection
    MongooseModule.forRoot(process.env.MONGODB_URI || 'mongodb://chasr:chasr_dev_secret@localhost:27017/chasr?authSource=admin'),
    // Redis connection for BullMQ
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_URL ? new URL(process.env.REDIS_URL).hostname : 'localhost',
        port: process.env.REDIS_URL ? parseInt(new URL(process.env.REDIS_URL).port || '6379', 10) : 6379,
      },
    }),
    // Feature Modules
    VaultModule,
    AuditModule,
    SyncModule,
    ConnectorsModule,
    IntegrationsModule,
    InviteModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
