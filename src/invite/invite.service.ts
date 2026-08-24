// src/invite/invite.service.ts
import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { InviteToken } from '../integrations/schemas/invite-token.schema';
import { AuditLoggerService } from '../audit/audit-logger.service';

@Injectable()
export class InviteService {
  private readonly logger = new Logger(InviteService.name);

  constructor(
    @InjectModel(InviteToken.name)
    private readonly inviteModel: Model<InviteToken>,
    private readonly auditLogger: AuditLoggerService,
  ) {}

  async createInvite(
    orgId: string,
    createdByUserId: string,
    provider: string,
    inviteeEmail?: string,
  ): Promise<{ inviteUrl: string; token: string; expiresAt: Date }> {
    // Check rate limit: max 10 active invites per org
    const activeCount = await this.inviteModel.countDocuments({
      orgId: new Types.ObjectId(orgId),
      redeemed: false,
      expiresAt: { $gt: new Date() },
    });
    
    if (activeCount >= 10) {
      throw new BadRequestException('Too many active invites. Please revoke some before creating new ones.');
    }

    // 256-bit entropy token
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await this.inviteModel.create({
      orgId: new Types.ObjectId(orgId),
      token,
      provider,
      createdByUserId,
      inviteeEmail,
      expiresAt,
    });

    await this.auditLogger.log({
      orgId: new Types.ObjectId(orgId),
      actor: createdByUserId,
      event: 'invite.created',
      outcome: 'success',
      metadata: { provider, inviteeEmail, expiresAt },
    });

    const inviteUrl = `${process.env.APP_URL}/integrations/connect/${token}`;

    if (inviteeEmail) {
      this.logger.log(`Sending invite email to ${inviteeEmail} for provider ${provider}`);
      // TODO: integrate with real email service (Nodemailer/Sendgrid) in phase 2
    }

    return { inviteUrl, token, expiresAt };
  }

  async validateAndConsumeInvite(token: string, ip: string): Promise<InviteToken> {
    const invite = await this.inviteModel.findOne({ token });

    if (!invite) throw new NotFoundException('Invalid invite link');
    if (invite.redeemed) throw new BadRequestException('This invite has already been used');
    if (invite.expiresAt < new Date()) throw new BadRequestException('This invite has expired');

    // Rate limit redemption attempts
    await this.inviteModel.updateOne({ _id: invite._id }, { $inc: { redemptionAttempts: 1 } });
    if (invite.redemptionAttempts >= 5) {
      throw new BadRequestException('Too many invalid redemption attempts');
    }

    return invite;
  }

  async redeemInvite(token: string, connectionId: string, ip: string): Promise<void> {
    await this.inviteModel.updateOne(
      { token },
      { $set: { redeemed: true, redeemedAt: new Date(), redeemedByIp: ip } }
    );

    const invite = await this.inviteModel.findOne({ token });

    if (!invite) return;

    // Notify the original admin
    this.logger.log(`Notifying admin ${invite.createdByUserId} that invite ${token} was redeemed`);
    // TODO: integrate with notification service

    await this.auditLogger.log({
      orgId: invite.orgId,
      actor: `invite:${token.slice(0, 8)}`,
      event: 'invite.redeemed',
      outcome: 'success',
      metadata: { provider: invite.provider, ip, connectionId },
    });
  }

  async listInvites(orgId: string): Promise<InviteToken[]> {
    return this.inviteModel.find({ orgId: new Types.ObjectId(orgId) }).sort({ createdAt: -1 }).exec();
  }

  async revokeInvite(orgId: string, inviteId: string, userId: string): Promise<void> {
    const invite = await this.inviteModel.findOne({ _id: new Types.ObjectId(inviteId), orgId: new Types.ObjectId(orgId) });
    if (!invite) throw new NotFoundException('Invite not found');
    
    // Revoke by setting expiry to past
    await this.inviteModel.updateOne(
      { _id: new Types.ObjectId(inviteId) },
      { $set: { expiresAt: new Date() } }
    );

    await this.auditLogger.log({
      orgId: new Types.ObjectId(orgId),
      actor: userId,
      event: 'invite.expired',
      outcome: 'success',
      metadata: { action: 'revoked', inviteId },
    });
  }
}
