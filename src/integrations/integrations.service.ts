// src/integrations/integrations.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AccountingConnection, Provider } from './schemas/accounting-connection.schema';
import { SyncLog } from './schemas/sync-log.schema';
import { SyncOrchestratorService } from '../sync/sync-orchestrator.service';
import { ConnectorFactory } from '../connectors/connector.factory';
import { VaultService } from '../credential-vault/vault.service';
import { AuditLoggerService } from '../audit/audit-logger.service';

@Injectable()
export class IntegrationsService {
  constructor(
    @InjectModel(AccountingConnection.name)
    private readonly connectionModel: Model<AccountingConnection>,
    @InjectModel(SyncLog.name)
    private readonly syncLogModel: Model<SyncLog>,
    private readonly orchestrator: SyncOrchestratorService,
    private readonly connectorFactory: ConnectorFactory,
    private readonly vault: VaultService,
    private readonly auditLogger: AuditLoggerService,
  ) {}

  async getConnections(orgId: string): Promise<AccountingConnection[]> {
    return this.connectionModel
      .find({ orgId: new Types.ObjectId(orgId), isDeleted: false })
      .select('-credentials') // Never return credentials to client
      .exec();
  }

  async getConnection(orgId: string, connectionId: string): Promise<{ connection: AccountingConnection, recentLogs: SyncLog[] }> {
    const connection = await this.connectionModel
      .findOne({ _id: new Types.ObjectId(connectionId), orgId: new Types.ObjectId(orgId), isDeleted: false })
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

  async deleteConnection(orgId: string, connectionId: string, userId: string): Promise<void> {
    const connection = await this.connectionModel.findOne({
      _id: new Types.ObjectId(connectionId),
      orgId: new Types.ObjectId(orgId),
      isDeleted: false,
    });

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    // Try to revoke tokens with provider
    if (connection.provider !== 'csv') {
      try {
        const connector = this.connectorFactory.getConnector(connection.provider);
        await connector.revokeAccess(connection);
      } catch (err) {
        // Log but continue deletion
      }
    }

    await this.connectionModel.updateOne(
      { _id: new Types.ObjectId(connectionId) },
      { $set: { isDeleted: true, deletedAt: new Date(), status: 'disconnected', credentials: {} } },
    );

    await this.auditLogger.log({
      orgId: new Types.ObjectId(orgId),
      actor: userId,
      event: 'connection.revoked',
      outcome: 'success',
      metadata: { connectionId, provider: connection.provider },
    });
  }

  async getSyncLogs(orgId: string, connectionId: string, page: number = 1, limit: number = 50): Promise<SyncLog[]> {
    return this.syncLogModel
      .find({
        connectionId: new Types.ObjectId(connectionId),
        orgId: new Types.ObjectId(orgId),
      })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .exec();
  }

  async getSyncLogDetail(orgId: string, syncLogId: string): Promise<SyncLog> {
    const log = await this.syncLogModel.findOne({
      _id: new Types.ObjectId(syncLogId),
      orgId: new Types.ObjectId(orgId),
    }).exec();
    if (!log) throw new NotFoundException('Sync log not found');
    return log;
  }

  async triggerManualSync(orgId: string, connectionId: string, userId: string): Promise<{ jobId: string, syncLogId: string }> {
    return this.orchestrator.dispatchFullSync(connectionId, orgId, userId);
  }

  async getSyncStatus(jobId: string) {
    return this.orchestrator.getJobStatus(jobId);
  }

  async createCredentialConnection(orgId: string, provider: Provider, authMethod: string, credentials: Record<string, string>, userId: string): Promise<AccountingConnection> {
    // Encrypt all string values in the credentials object
    const encryptedCredentials: Record<string, string> = {};
    for (const [key, value] of Object.entries(credentials)) {
      if (typeof value === 'string') {
         encryptedCredentials[`encrypted_${key}`] = this.vault.encrypt(value);
      }
    }

    const connection = await this.connectionModel.create({
      orgId: new Types.ObjectId(orgId),
      provider: provider as any,
      authMethod: authMethod as any,
      credentials: encryptedCredentials,
      status: 'connected',
    });

    await this.auditLogger.log({
      orgId: new Types.ObjectId(orgId),
      actor: userId,
      event: 'connection.created',
      outcome: 'success',
      metadata: { provider, authMethod },
    });

    return connection;
  }
}
