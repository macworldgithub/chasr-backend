// src/connectors/xero/xero-oauth.service.ts
import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import axios from 'axios';
import { Redis } from 'ioredis';
import { VaultService } from '../../credential-vault/vault.service';
import { AuditLoggerService } from '../../audit/audit-logger.service';
import { AccountingConnection } from '../../integrations/schemas/accounting-connection.schema';
import { normalizeOrgId } from '../../shared/utils/org-id.util';

// const XERO_SCOPES =
//   'openid profile email accounting.transactions accounting.contacts accounting.settings offline_access';
const XERO_SCOPES =
  'openid profile email accounting.invoices accounting.payments accounting.contacts accounting.settings offline_access';

const XERO_AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
const XERO_REVOKE_URL = 'https://identity.xero.com/connect/revocation';

export interface XeroOAuthExchangeResult {
  connection: AccountingConnection;
  orgId: string;
  userId: string;
  tenants: Array<{ tenantId: string; tenantName: string }>;
}

@Injectable()
export class XeroOAuthService {
  private readonly logger = new Logger(XeroOAuthService.name);
  private readonly redis = new Redis(
    process.env.REDIS_URL || 'redis://localhost:6379',
  );

  constructor(
    @InjectModel(AccountingConnection.name)
    private readonly connectionModel: Model<AccountingConnection>,
    private readonly vault: VaultService,
    private readonly auditLogger: AuditLoggerService,
  ) {}

  /**
   * Generate a Xero OAuth 2.0 PKCE authorization URL.
   * Stores the code_verifier + orgId + userId in Redis with a 10-minute TTL.
   */
  async generateAuthUrl(
    orgId: string,
    userId: string,
  ): Promise<{ authUrl: string; state: string }> {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    const state = randomBytes(16).toString('hex');

    const redisKey = `xero:pkce:${state}`;
    await this.redis.set(
      redisKey,
      JSON.stringify({ codeVerifier, orgId, userId }),
      'EX',
      600, // 10 minutes
    );

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.XERO_CLIENT_ID!,
      redirect_uri: process.env.XERO_REDIRECT_URI!,
      scope: XERO_SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return { authUrl: `${XERO_AUTH_URL}?${params}`, state };
  }

  /**
   * Exchange authorization code for tokens.
   * Encrypts tokens before persisting. Creates or updates AccountingConnection.
   * Triggers an initial full sync job (called by IntegrationsService after this).
   */
  async exchangeCode(
    code: string,
    state: string,
  ): Promise<XeroOAuthExchangeResult> {
    const stored = await this.redis.get(`xero:pkce:${state}`);
    if (!stored) {
      throw new BadRequestException(
        'Invalid or expired OAuth state. Please restart the connection flow.',
      );
    }

    const { codeVerifier, orgId, userId } = JSON.parse(stored) as {
      codeVerifier: string;
      orgId: string;
      userId: string;
    };
    await this.redis.del(`xero:pkce:${state}`);

    // Exchange code for tokens
    const tokenResp = await axios.post(
      XERO_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.XERO_REDIRECT_URI!,
        client_id: process.env.XERO_CLIENT_ID!,
        client_secret: process.env.XERO_CLIENT_SECRET!,
        code_verifier: codeVerifier,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    const { access_token, refresh_token, expires_in } = tokenResp.data as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    // Fetch tenant list (MVP: use first tenant)
    const tenantsResp = await axios.get<
      Array<{ tenantId: string; tenantName: string }>
    >(XERO_CONNECTIONS_URL, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!tenantsResp.data.length) {
      throw new BadRequestException(
        'No Xero organisations connected to this account.',
      );
    }

    const tenants = tenantsResp.data;
    const tenant = tenants[0];

    const normalizedOrgId = normalizeOrgId(orgId);

    const connection = await this.connectionModel.findOneAndUpdate(
      { orgId: normalizedOrgId, provider: 'xero', isDeleted: false },
      {
        $set: {
          authMethod: 'oauth2',
          status: 'connected',
          credentials: {
            encryptedAccessToken: this.vault.encrypt(access_token),
            encryptedRefreshToken: this.vault.encrypt(refresh_token),
            tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
            tenantId: tenant.tenantId,
            tenantName: tenant.tenantName,
            scopes: XERO_SCOPES.split(' '),
          },
        },
        $setOnInsert: {
          orgId: normalizedOrgId,
          provider: 'xero',
          isDeleted: false,
          settings: {
            syncFrequencyMinutes: Number(
              process.env.DEFAULT_SYNC_FREQUENCY_MINUTES ?? 30,
            ),
            lookbackMonths: Number(process.env.DEFAULT_LOOKBACK_MONTHS ?? 18),
          },
        },
      },
      { upsert: true, new: true },
    );

    await this.auditLogger.log({
      orgId: normalizedOrgId as any,
      actor: userId,
      event: 'connection.created',
      outcome: 'success',
      metadata: { provider: 'xero', tenantName: tenant.tenantName },
    });

    return {
      connection: connection!,
      orgId,
      userId,
      tenants,
    };
  }

  async getTenants(connectionId: string): Promise<Array<{ tenantId: string; tenantName: string }>> {
    const connection = await this.connectionModel.findById(connectionId);
    if (!connection || connection.provider !== 'xero') {
      throw new BadRequestException('Invalid Xero connection');
    }
    const accessToken = this.vault.decrypt(
      connection.credentials.encryptedAccessToken,
    );
    const tenantsResp = await axios.get<
      Array<{ tenantId: string; tenantName: string }>
    >(XERO_CONNECTIONS_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return tenantsResp.data;
  }

  async selectTenant(
    connectionId: string,
    tenantId: string,
  ): Promise<AccountingConnection> {
    const connection = await this.connectionModel.findById(connectionId);
    if (!connection || connection.provider !== 'xero') {
      throw new BadRequestException('Invalid Xero connection');
    }

    const accessToken = this.vault.decrypt(
      connection.credentials.encryptedAccessToken,
    );
    const tenantsResp = await axios.get<
      Array<{ tenantId: string; tenantName: string }>
    >(XERO_CONNECTIONS_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const tenant = tenantsResp.data.find((t) => t.tenantId === tenantId);
    if (!tenant) {
      throw new BadRequestException('Tenant not found in connected Xero account.');
    }

    return this.connectionModel.findByIdAndUpdate(
      connectionId,
      {
        $set: {
          'credentials.tenantId': tenant.tenantId,
          'credentials.tenantName': tenant.tenantName,
        },
      },
      { new: true },
    ).exec() as Promise<AccountingConnection>;
  }

  /**
   * Refresh the Xero access token using the stored refresh token.
   * Returns updated connection document with new encrypted tokens.
   */
  async refreshAccessToken(
    connection: AccountingConnection,
  ): Promise<AccountingConnection> {
    const rawRefreshToken =
      connection.credentials?.encryptedRefreshToken ??
      connection.credentials?.encrypted_refreshToken ??
      connection.credentials?.encrypted_refresh_token;

    if (!rawRefreshToken) {
      await this.connectionModel.findByIdAndUpdate(connection._id, {
        $set: {
          status: 'error',
          lastSyncError:
            'Xero connection requires re-authentication (refresh token missing).',
        },
      });
      throw new Error(
        `Xero connection ${connection._id} has no refresh token in credentials bag`,
      );
    }

    const refreshToken = this.vault.decrypt(rawRefreshToken);

    try {
      const resp = await axios.post(
        XERO_TOKEN_URL,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: process.env.XERO_CLIENT_ID!,
          client_secret: process.env.XERO_CLIENT_SECRET!,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );

      const {
        access_token,
        refresh_token: newRefreshToken,
        expires_in,
      } = resp.data as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };

      const updated = await this.connectionModel.findByIdAndUpdate(
        connection._id,
        {
          $set: {
            'credentials.encryptedAccessToken': this.vault.encrypt(access_token),
            'credentials.encryptedRefreshToken':
              this.vault.encrypt(newRefreshToken),
            'credentials.tokenExpiresAt': new Date(
              Date.now() + expires_in * 1000,
            ),
          },
        },
        { new: true },
      );

      this.logger.log(`Refreshed Xero token for connection ${connection._id}`);
      return updated!;
    } catch (err: any) {
      const errorMsg =
        err.response?.data?.error_description ||
        err.response?.data?.error ||
        err.message;
      this.logger.error(
        `Failed to refresh Xero token for connection ${connection._id}: ${errorMsg}`,
      );

      if (err.response?.status === 400 || err.response?.status === 401) {
        await this.connectionModel.findByIdAndUpdate(connection._id, {
          $set: {
            status: 'error',
            lastSyncError:
              'Xero authorization expired or revoked. Please reconnect your Xero account.',
          },
        });
      }

      throw new Error(
        `Xero token refresh failed (${errorMsg}). User may need to re-authenticate.`,
      );
    }
  }

  /**
   * Revoke tokens with Xero's revocation endpoint.
   */
  async revokeTokens(connection: AccountingConnection): Promise<void> {
    try {
      const refreshToken = this.vault.decrypt(
        connection.credentials.encryptedRefreshToken ??
          connection.credentials.encrypted_refreshToken ??
          connection.credentials.encrypted_refresh_token,
      );
      await axios.post(
        XERO_REVOKE_URL,
        new URLSearchParams({ token: refreshToken }),
        {
          auth: {
            username: process.env.XERO_CLIENT_ID!,
            password: process.env.XERO_CLIENT_SECRET!,
          },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';

      // Log but don't throw — we still want to soft-delete the connection
      this.logger.warn(
        `Failed to revoke Xero tokens for connection ${connection._id}: ${message}`,
      );
    }
  }
}
