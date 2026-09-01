// src/invite/invite.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { InviteController } from './invite.controller';
import { InviteService } from './invite.service';
import { ConnectorsModule } from '../connectors/connectors.module';
import { AuditModule } from '../audit/audit.module';
import { OrgScopeGuard } from '../shared/guards/org-scope.guard';
import {
  InviteToken,
  InviteTokenSchema,
} from '../integrations/schemas/invite-token.schema';

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
      { name: InviteToken.name, schema: InviteTokenSchema },
    ]),
    ConnectorsModule,
    AuditModule,
  ],
  controllers: [InviteController],
  providers: [InviteService, OrgScopeGuard],
  exports: [InviteService],
})
export class InviteModule {}
