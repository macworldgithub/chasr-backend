// src/sync/sync.types.ts

/** Payload carried by every BullMQ sync job */
export interface SyncJobData {
  type: 'full_sync' | 'incremental_sync' | 'webhook_event' | 'csv_ingest';
  connectionId: string;
  orgId: string;
  triggeredBy: string; // userId | 'scheduler' | 'system:webhook'
  triggerType: 'manual' | 'scheduled' | 'webhook' | 'csv_upload';
  webhookPayload?: any; // webhook_event jobs only
  csvUploadId?: string; // csv_ingest jobs only
  csvMappings?: Array<{ sourceColumn: string; targetField: string }>; // csv_ingest jobs
  syncLogId?: string;   // Pre-created SyncLog ID for tracking
}
