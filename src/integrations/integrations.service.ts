// src/integrations/integrations.service.ts
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  AccountingConnection,
  Provider,
} from './schemas/accounting-connection.schema';
import { SyncLog } from './schemas/sync-log.schema';
import { XeroOrganisation } from './schemas/xero-organisation.schema';
import { SyncOrchestratorService } from '../sync/sync-orchestrator.service';
import { ConnectorFactory } from '../connectors/connector.factory';
import { VaultService } from '../credential-vault/vault.service';
import { AuditLoggerService } from '../audit/audit-logger.service';
import { normalizeOrgId } from '../shared/utils/org-id.util';

@Injectable()
export class IntegrationsService {
  constructor(
    @InjectModel(AccountingConnection.name)
    private readonly connectionModel: Model<AccountingConnection>,
    @InjectModel(SyncLog.name)
    private readonly syncLogModel: Model<SyncLog>,
    @InjectModel(XeroOrganisation.name)
    private readonly xeroOrgModel: Model<XeroOrganisation>,
    private readonly orchestrator: SyncOrchestratorService,
    private readonly connectorFactory: ConnectorFactory,
    private readonly vault: VaultService,
    private readonly auditLogger: AuditLoggerService,
  ) {}

  async getConnections(orgId: string): Promise<AccountingConnection[]> {
    const normalizedOrgId = normalizeOrgId(orgId);

    return this.connectionModel
      .find({ orgId: normalizedOrgId, isDeleted: false })
      .select('-credentials') // Never return credentials to client
      .exec();
  }

  async getConnection(
    orgId: string,
    connectionId: string,
  ): Promise<{ connection: AccountingConnection; recentLogs: SyncLog[] }> {
    const normalizedOrgId = normalizeOrgId(orgId);
    const connection = await this.connectionModel
      .findOne({
        _id: new Types.ObjectId(connectionId),
        orgId: normalizedOrgId,
        isDeleted: false,
      })
      .select('-credentials')
      .exec();

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    const recentLogs = await this.syncLogModel
      .find({ connectionId: new Types.ObjectId(connectionId) })
      .sort({ createdAt: -1 })
      .limit(50)
      .exec();

    return { connection, recentLogs };
  }

  async deleteConnection(
    orgId: string,
    connectionId: string,
    userId: string,
  ): Promise<void> {
    const normalizedOrgId = normalizeOrgId(orgId);
    const connection = await this.connectionModel.findOne({
      _id: new Types.ObjectId(connectionId),
      orgId: normalizedOrgId,
      isDeleted: false,
    });

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    // Try to revoke tokens with provider
    if (connection.provider !== 'csv') {
      try {
        const connector = this.connectorFactory.getConnector(
          connection.provider,
        );
        await connector.revokeAccess(connection);
      } catch (err) {
        // Log but continue deletion
      }
    }

    await this.connectionModel.updateOne(
      { _id: new Types.ObjectId(connectionId) },
      {
        $set: {
          isDeleted: true,
          deletedAt: new Date(),
          status: 'disconnected',
          credentials: {},
        },
      },
    );

    await this.auditLogger.log({
      orgId: normalizeOrgId(orgId) as any,
      actor: userId,
      event: 'connection.revoked',
      outcome: 'success',
      metadata: { connectionId, provider: connection.provider },
    });
  }

  async getSyncLogs(
    orgId: string,
    connectionId: string,
    page: number = 1,
    limit: number = 50,
  ): Promise<SyncLog[]> {
    const normalizedOrgId = normalizeOrgId(orgId);
    return this.syncLogModel
      .find({
        connectionId: new Types.ObjectId(connectionId),
        orgId: normalizedOrgId,
      })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .exec();
  }

  async getSyncLogDetail(orgId: string, syncLogId: string): Promise<SyncLog> {
    const normalizedOrgId = normalizeOrgId(orgId);
    const log = await this.syncLogModel
      .findOne({
        _id: new Types.ObjectId(syncLogId),
        orgId: normalizedOrgId,
      })
      .exec();
    if (!log) throw new NotFoundException('Sync log not found');
    return log;
  }

  async getOrganisation(orgId: string, connectionId: string): Promise<XeroOrganisation> {
    const normalizedOrgId = normalizeOrgId(orgId);
    const org = await this.xeroOrgModel.findOne({
      connectionId: new Types.ObjectId(connectionId),
      orgId: normalizedOrgId,
    }).exec();

    if (!org) {
      throw new NotFoundException('Organisation info not found');
    }
    return org;
  }

  async triggerManualSync(
    orgId: string,
    connectionId: string,
    userId: string,
  ): Promise<{ jobId: string; syncLogId: string }> {
    return this.orchestrator.dispatchFullSync(connectionId, orgId, userId);
  }

  async getSyncStatus(jobId: string) {
    return this.orchestrator.getJobStatus(jobId);
  }

  async createCredentialConnection(
    orgId: string,
    provider: Provider,
    authMethod: string,
    credentials: Record<string, string>,
    userId: string,
  ): Promise<AccountingConnection> {
    const normalizedOrgId = normalizeOrgId(orgId);

    if (!credentials || Object.keys(credentials).length === 0) {
      throw new BadRequestException('Credentials payload cannot be empty');
    }

    if (['xero', 'quickbooks', 'myob'].includes(provider) && authMethod === 'oauth2') {
      const hasToken =
        credentials.accessToken ||
        credentials.encryptedAccessToken ||
        credentials.encrypted_accessToken;
      if (!hasToken) {
        throw new BadRequestException(
          `Missing required accessToken in credentials payload for provider '${provider}'`,
        );
      }
    }

    // Normalize to the canonical encrypted key names used by the connectors.
    const encryptedCredentials: Record<string, string> = {};
    for (const [key, value] of Object.entries(credentials)) {
      if (typeof value !== 'string') continue;

      const canonicalKey =
        key === 'accessToken'
          ? 'encryptedAccessToken'
          : key === 'refreshToken'
            ? 'encryptedRefreshToken'
            : key === 'apiKey'
              ? 'encryptedApiKey'
              : key === 'apiSecret'
                ? 'encryptedApiSecret'
                : key.startsWith('encrypted')
                  ? key
                  : `encrypted_${key}`;

      encryptedCredentials[canonicalKey] = this.vault.encrypt(value);
    }

    // Validate credentials against provider API if applicable
    if (provider !== 'csv') {
      try {
        const connector = this.connectorFactory.getConnector(provider);
        const tempDoc = new this.connectionModel({
          orgId: normalizedOrgId,
          provider,
          authMethod,
          credentials: encryptedCredentials,
        });
        const isValid = await connector.validateConnection(tempDoc as any);
        if (!isValid) {
          throw new BadRequestException(
            `Invalid credentials: authentication failed with ${provider}. Please verify your access token or reconnect.`,
          );
        }
      } catch (err) {
        if (err instanceof BadRequestException) {
          throw err;
        }
        throw new BadRequestException(
          `Invalid credentials: authentication failed with ${provider}. Please verify your access token or reconnect.`,
        );
      }
    }

    const connection = await this.connectionModel.create({
      orgId: normalizedOrgId,
      provider: provider as any,
      authMethod: authMethod as any,
      credentials: encryptedCredentials,
      status: 'connected',
    });

    await this.auditLogger.log({
      orgId: normalizedOrgId as any,
      actor: userId,
      event: 'connection.created',
      outcome: 'success',
      metadata: { provider, authMethod, status: 'connected' },
    });

    return connection;
  }
}
