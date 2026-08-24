// migrations/001-accounting-integration.js
// Run against MongoDB using mongosh:
//   mongosh $MONGODB_URI migrations/001-accounting-integration.js

// ── New collections ───────────────────────────────────────────────────────
db.createCollection('accountingconnections');
db.createCollection('synclogs');
db.createCollection('auditlogs');
db.createCollection('invitetokens');

// ── Indexes: accountingconnections ────────────────────────────────────────
db.accountingconnections.createIndex(
  { orgId: 1, provider: 1, isDeleted: 1 },
  { name: 'idx_connection_org_provider' },
);

// ── Indexes: synclogs ─────────────────────────────────────────────────────
db.synclogs.createIndex(
  { connectionId: 1, createdAt: -1 },
  { name: 'idx_synclog_connection_date' },
);
db.synclogs.createIndex(
  { orgId: 1, createdAt: -1 },
  { name: 'idx_synclog_org_date' },
);

// ── Indexes: auditlogs ────────────────────────────────────────────────────
db.auditlogs.createIndex(
  { orgId: 1, createdAt: -1 },
  { name: 'idx_auditlog_org_date' },
);

// ── Indexes: invitetokens ─────────────────────────────────────────────────
db.invitetokens.createIndex(
  { token: 1 },
  { unique: true, name: 'idx_invitetoken_token' },
);
// TTL index — MongoDB auto-deletes expired invite tokens
db.invitetokens.createIndex(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'idx_invitetoken_ttl' },
);

// ── Indexes: invoices (additions) ─────────────────────────────────────────
// Unique compound index for idempotent upserts. sparse=true so nulls are ignored.
db.invoices.createIndex(
  { orgId: 1, externalId: 1, externalSource: 1 },
  { unique: true, sparse: true, name: 'idx_invoice_external' },
);

// ── Indexes: contacts (additions) ─────────────────────────────────────────
db.contacts.createIndex(
  { orgId: 1, externalId: 1, externalSource: 1 },
  { unique: true, sparse: true, name: 'idx_contact_external' },
);

// ── Indexes: payments (additions) ─────────────────────────────────────────
db.payments.createIndex(
  { orgId: 1, externalId: 1, externalSource: 1 },
  { unique: true, sparse: true, name: 'idx_payment_external' },
);

// ── Backfill existing docs with null integration fields ───────────────────
db.invoices.updateMany(
  { externalSource: { $exists: false } },
  { $set: { externalSource: null, externalId: null, externalConnectionId: null, lastSyncedAt: null } },
);
db.contacts.updateMany(
  { externalSource: { $exists: false } },
  { $set: { externalSource: null, externalId: null, externalConnectionId: null, lastSyncedAt: null } },
);
db.payments.updateMany(
  { externalSource: { $exists: false } },
  { $set: { externalSource: null, externalId: null, externalConnectionId: null, lastSyncedAt: null } },
);

print('Migration 001-accounting-integration completed successfully.');
