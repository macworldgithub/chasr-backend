// src/connectors/myob/myob-oauth.service.ts
import { Injectable, Logger, NotImplementedException } from '@nestjs/common';
import { AccountingConnection } from '../../integrations/schemas/accounting-connection.schema';

/**
 * MYOB OAuth Service — Phase 1 skeleton.
 *
 * MYOB AccountRight uses OAuth 2.0 (cloud) or API key (desktop instances).
 * Full implementation is Phase 2.
 *
 * MYOB OAuth endpoints:
 *   Auth:    https://secure.myob.com/oauth2/account/authorize
 *   Token:   https://secure.myob.com/oauth2/v1/authorize
 *   Refresh: same token endpoint with grant_type=refresh_token
 *
 * API base: https://api.myob.com/accountright/
 */
@Injectable()
export class MyobOAuthService {
  private readonly logger = new Logger(MyobOAuthService.name);

  async generateAuthUrl(
    orgId: string,
    userId: string,
  ): Promise<{ authUrl: string; state: string }> {
    // TODO Phase 2: Implement MYOB OAuth flow
    throw new NotImplementedException(
      'MYOB OAuth is coming in Phase 2. Use CSV import for now.',
    );
  }

  async exchangeCode(
    code: string,
    state: string,
  ): Promise<AccountingConnection> {
    throw new NotImplementedException('MYOB OAuth is coming in Phase 2.');
  }

  async refreshAccessToken(
    connection: AccountingConnection,
  ): Promise<AccountingConnection> {
    throw new NotImplementedException('MYOB OAuth is coming in Phase 2.');
  }

  async revokeTokens(connection: AccountingConnection): Promise<void> {
    this.logger.warn(`MYOB token revocation not yet implemented for connection ${connection._id}`);
  }
}
