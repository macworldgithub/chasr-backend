// src/connectors/base.connector.ts
import { AccountingConnection } from '../integrations/schemas/accounting-connection.schema';

/**
 * Result object returned by all sync operations.
 * All counts are cumulative for the sync run.
 */
export interface SyncResult {
  contactsUpserted: number;
  invoicesUpserted: number;
  paymentsUpserted: number;
  recordsSkipped: number;
  recordsFailed: number;
  errors: string[];
}

/**
 * BaseConnector — abstract interface every accounting provider must implement.
 *
 * Design principles:
 * - All methods must be idempotent — calling twice produces no extra side effects.
 * - Credentials are decrypted inside the connector, never before.
 * - All methods should update the connection's lastSyncAt via the SyncProcessor.
 */
export abstract class BaseConnector {
  /**
   * Full historical sync — fetches everything within lookbackMonths.
   * Called once on initial connection and when user clicks "Sync Now".
   */
  abstract fullSync(connection: AccountingConnection): Promise<SyncResult>;

  /**
   * Incremental sync — only fetch records modified since `connection.lastSyncAt`.
   * Called by the scheduler every `syncFrequencyMinutes` minutes.
   */
  abstract incrementalSync(connection: AccountingConnection): Promise<SyncResult>;

  /**
   * Processes a single inbound webhook event from the provider.
   * Fetches only the specific changed resource (invoice, contact, payment).
   */
  abstract processWebhookEvent(
    connection: AccountingConnection,
    webhookPayload: any,
  ): Promise<SyncResult>;

  /**
   * Refresh OAuth access token if it expires within 5 minutes.
   * Returns the updated connection document (with new encrypted tokens).
   */
  abstract refreshTokensIfNeeded(
    connection: AccountingConnection,
  ): Promise<AccountingConnection>;

  /**
   * Performs a lightweight API call to verify the connection is still live.
   */
  abstract validateConnection(connection: AccountingConnection): Promise<boolean>;

  /**
   * Revoke provider-side access and clear stored credentials.
   * Called when a user disconnects their accounting system.
   */
  abstract revokeAccess(connection: AccountingConnection): Promise<void>;
}
