import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import axios from 'axios';
import { Redis } from 'ioredis';
import { VaultService } from '../../credential-vault/vault.service';
import { AuditLoggerService } from '../../audit/audit-logger.service';
import { AccountingConnection } from '../../integrations/schemas/accounting-connection.schema';

const QUICKBOOKS_TOKEN_URL =
  'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QUICKBOOKS_REVOKE_URL =
  'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const QUICKBOOKS_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';

@Injectable()
export class QuickBooksOAuthService {
  private readonly logger = new Logger(QuickBooksOAuthService.name);
  private readonly redis = new Redis(
    process.env.REDIS_URL || 'redis://localhost:6379',
  );

  constructor(
    @InjectModel(AccountingConnection.name)
    private readonly connectionModel: Model<AccountingConnection>,
    private readonly vault: VaultService,
    private readonly auditLogger: AuditLoggerService,
  ) {}

  async generateAuthUrl(
    orgId: string,
    userId: string,
  ): Promise<{ authUrl: string; state: string }> {
    const state = randomBytes(16).toString('hex');
    await this.redis.set(
      `quickbooks:oauth:${state}`,
      JSON.stringify({ orgId, userId }),
      'EX',
      600,
    );

    const params = new URLSearchParams({
      client_id: process.env.QUICKBOOKS_CLIENT_ID!,
      response_type: 'code',
      scope: 'com.intuit.quickbooks.accounting',
      redirect_uri: process.env.QUICKBOOKS_REDIRECT_URI!,
      state,
    });

    return {
      authUrl: `${QUICKBOOKS_AUTH_URL}?${params.toString()}`,
      state,
    };
  }

  async exchangeCode(
    code: string,
    state: string,
    realmId?: string,
  ): Promise<AccountingConnection> {
    const stored = await this.redis.get(`quickbooks:oauth:${state}`);
    if (!stored) {
      throw new BadRequestException(
        'Invalid or expired QuickBooks OAuth state. Please restart the connection flow.',
      );
    }

    const { orgId, userId } = JSON.parse(stored) as {
      orgId: string;
      userId: string;
    };
    await this.redis.del(`quickbooks:oauth:${state}`);

    const tokenResp = await axios.post(
      QUICKBOOKS_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.QUICKBOOKS_REDIRECT_URI!,
      }),
      {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${process.env.QUICKBOOKS_CLIENT_ID!}:${process.env.QUICKBOOKS_CLIENT_SECRET!}`,
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
      },
    );

    const {
      access_token,
      refresh_token,
      expires_in,
      x_refresh_token_expires_in,
    } = tokenResp.data as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      x_refresh_token_expires_in?: number;
    };

    const companyRealmId = realmId || (tokenResp.data as any).realmId;
    if (!companyRealmId) {
      throw new BadRequestException(
        'QuickBooks callback did not include a realmId. Please retry the connection flow.',
      );
    }

    const companyInfoResp = await axios.get(
      `https://quickbooks.api.intuit.com/v3/company/${companyRealmId}/companyinfo/${companyRealmId}`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: 'application/json',
        },
      },
    );

    const companyName =
      companyInfoResp.data?.CompanyInfo?.CompanyName ||
      companyInfoResp.data?.companyInfo?.CompanyName ||
      'QuickBooks Company';

    const connection = await this.connectionModel.findOneAndUpdate(
      {
        orgId: new Types.ObjectId(orgId),
        provider: 'quickbooks',
        isDeleted: false,
      },
      {
        $set: {
          authMethod: 'oauth2',
          status: 'connected',
          credentials: {
            encryptedAccessToken: this.vault.encrypt(access_token),
            encryptedRefreshToken: this.vault.encrypt(refresh_token),
            tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
            realmId: companyRealmId,
            tenantId: companyRealmId,
            tenantName: companyName,
            scopes: ['com.intuit.quickbooks.accounting'],
            xRefreshTokenExpiresIn: x_refresh_token_expires_in,
          },
        },
        $setOnInsert: {
          orgId: new Types.ObjectId(orgId),
          provider: 'quickbooks',
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
      orgId: new Types.ObjectId(orgId),
      actor: userId,
      event: 'connection.created',
      outcome: 'success',
      metadata: {
        provider: 'quickbooks',
        realmId: companyRealmId,
        companyName,
      },
    });

    return connection!;
  }

  async refreshAccessToken(
    connection: AccountingConnection,
  ): Promise<AccountingConnection> {
    const refreshToken = this.vault.decrypt(
      connection.credentials.encryptedRefreshToken,
    );

    const resp = await axios.post(
      QUICKBOOKS_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${process.env.QUICKBOOKS_CLIENT_ID!}:${process.env.QUICKBOOKS_CLIENT_SECRET!}`,
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
      },
    );

    const {
      access_token,
      refresh_token: newRefreshToken,
      expires_in,
      x_refresh_token_expires_in,
    } = resp.data as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      x_refresh_token_expires_in?: number;
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
          'credentials.xRefreshTokenExpiresIn': x_refresh_token_expires_in,
        },
      },
      { new: true },
    );

    this.logger.log(
      `Refreshed QuickBooks token for connection ${connection._id}`,
    );
    return updated!;
  }

  async revokeTokens(connection: AccountingConnection): Promise<void> {
    try {
      const refreshToken = this.vault.decrypt(
        connection.credentials.encryptedRefreshToken,
      );

      await axios.post(
        QUICKBOOKS_REVOKE_URL,
        new URLSearchParams({ token: refreshToken }),
        {
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${process.env.QUICKBOOKS_CLIENT_ID!}:${process.env.QUICKBOOKS_CLIENT_SECRET!}`,
            ).toString('base64')}`,
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to revoke QuickBooks access for connection ${connection._id}: ${err.message}`,
      );
    }
  }
}
