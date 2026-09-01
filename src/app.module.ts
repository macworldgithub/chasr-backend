// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuthModule } from './auth/auth.module';
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
    EventEmitterModule.forRoot(),
    // JWT setup for the OrgScopeGuard
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
    // MongoDB connection
    MongooseModule.forRoot(
      process.env.MONGODB_URI ||
        'mongodb://chasr:chasr_dev_secret@localhost:27017/chasr?authSource=admin',
    ),
    // Redis connection for BullMQ
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_URL
          ? new URL(process.env.REDIS_URL).hostname
          : 'localhost',
        port: process.env.REDIS_URL
          ? parseInt(new URL(process.env.REDIS_URL).port || '6379', 10)
          : 6379,
      },
    }),
    // Feature Modules
    AuthModule,
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
