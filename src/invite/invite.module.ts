// src/invite/invite.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { InviteController } from './invite.controller';
import { InviteService } from './invite.service';
import { ConnectorsModule } from '../connectors/connectors.module';
import { AuditModule } from '../audit/audit.module';
import {
  InviteToken,
  InviteTokenSchema,
} from '../integrations/schemas/invite-token.schema';

@Module({
  imports: [
    JwtModule,
    MongooseModule.forFeature([
      { name: InviteToken.name, schema: InviteTokenSchema },
    ]),
    ConnectorsModule,
    AuditModule,
  ],
  controllers: [InviteController],
  providers: [InviteService],
  exports: [InviteService],
})
export class InviteModule {}
