// src/invite/invite.controller.ts
import { Controller, Get, Post, Delete, Body, Param, Req, UseGuards, Ip, BadRequestException, Query } from '@nestjs/common';
import { InviteService } from './invite.service';
import { OrgScopeGuard } from '../shared/guards/org-scope.guard';
import { XeroOAuthService } from '../connectors/xero/xero-oauth.service';
import { MyobOAuthService } from '../connectors/myob/myob-oauth.service';

@Controller('integrations/invites')
export class InviteController {
  constructor(
    private readonly inviteService: InviteService,
    private readonly xeroOAuth: XeroOAuthService,
    private readonly myobOAuth: MyobOAuthService,
  ) {}

  // ── Protected (Admin) Endpoints ─────────────────────────────────────────────

  @Post()
  @UseGuards(OrgScopeGuard)
  async createInvite(@Req() req: any, @Body() body: { provider: string; inviteeEmail?: string }) {
    if (!['xero', 'myob', 'csv'].includes(body.provider)) throw new BadRequestException('Invalid provider');
    return this.inviteService.createInvite(req.orgId, req.user.id, body.provider, body.inviteeEmail);
  }

  @Get()
  @UseGuards(OrgScopeGuard)
  async listInvites(@Req() req: any) {
    return this.inviteService.listInvites(req.orgId);
  }

  @Delete(':id')
  @UseGuards(OrgScopeGuard)
  async revokeInvite(@Req() req: any, @Param('id') id: string) {
    await this.inviteService.revokeInvite(req.orgId, id, req.user.id);
    return { success: true };
  }

  // ── Public Endpoints (for the invitee) ──────────────────────────────────────

  @Get('redeem/:token')
  async getInviteDetails(@Param('token') token: string, @Ip() ip: string) {
    const invite = await this.inviteService.validateAndConsumeInvite(token, ip);
    return {
      provider: invite.provider,
      inviterEmail: invite.createdByUserId, // Would look up real email in a full system
      inviteeEmail: invite.inviteeEmail,
    };
  }

  @Post('redeem/:token/xero/auth-url')
  async getRedeemXeroAuthUrl(@Param('token') token: string, @Ip() ip: string) {
    const invite = await this.inviteService.validateAndConsumeInvite(token, ip);
    // Use the invite token string as a synthetic userId for audit purposes
    return this.xeroOAuth.generateAuthUrl(invite.orgId.toString(), `invite:${token.slice(0, 8)}`);
  }

  @Get('redeem/:token/xero/callback')
  async handleRedeemXeroCallback(@Param('token') token: string, @Query('code') code: string, @Query('state') state: string, @Ip() ip: string) {
    if (!code || !state) throw new BadRequestException('Missing code or state');
    const invite = await this.inviteService.validateAndConsumeInvite(token, ip);
    
    // Exchange the code
    const connection = await this.xeroOAuth.exchangeCode(code, state);
    
    // Mark as redeemed
    await this.inviteService.redeemInvite(token, connection._id.toString(), ip);
    
    return { success: true, connectionId: connection._id };
  }

  @Post('redeem/:token/myob/auth-url')
  async getRedeemMyobAuthUrl(@Param('token') token: string, @Ip() ip: string) {
    const invite = await this.inviteService.validateAndConsumeInvite(token, ip);
    return this.myobOAuth.generateAuthUrl(invite.orgId.toString(), `invite:${token.slice(0, 8)}`);
  }
}
