# Bugfix Requirements Document

## Introduction

Two related bugs in the sync status system cause the frontend to poll indefinitely and the
chase engine to re-fire events for the same invoices.

**Bug 1 — Infinite polling after sync completes.**
`SyncOrchestratorService.getJobStatus()` reads the BullMQ job from Redis. Because
`dispatchFullSync` configures `removeOnComplete: { count: 100 }`, Redis removes the job
shortly after completion. Once removed, `syncQueue.getJob(jobId)` returns `null` and
`getJobStatus()` returns `{ status: 'unknown' }`. The frontend stops polling only on
`'completed'` or `'failed'`, so `'unknown'` keeps it polling forever. The `'partial'`
status (set by `sync.processor.ts` when sync errors are non-empty) is also never returned
by `getJobStatus()`, meaning even a partial completion doesn't terminate the poll loop.

**Bug 2 — Unlimited BullMQ retries re-run the full sync.**
`dispatchFullSync` enqueues the job without an `attempts` limit, so BullMQ falls back to
its default retry behaviour on any worker error. The processor re-throws errors to trigger
retries, which re-runs `fullSync()` from scratch on every attempt. This causes
`ChaseEngineService` to emit `Chase halt signalled` repeatedly for the same invoice IDs.

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a sync job completes and BullMQ removes it from Redis AND the frontend calls
`GET /integrations/connections/:id/sync-status/:jobId` THEN the system returns
`{ status: 'unknown', progress: 0 }` instead of the actual terminal status.

1.2 WHEN `getJobStatus()` returns `'unknown'` THEN the frontend poll loop continues
indefinitely because `'unknown'` is not a terminal status.

1.3 WHEN a sync job completes with non-empty errors AND BullMQ still holds the job THEN
`getJobStatus()` returns the BullMQ state `'completed'` rather than `'partial'`, so the
SyncLog terminal status is not reflected in the polling response.

1.4 WHEN `dispatchFullSync` enqueues a job without an `attempts` cap AND the worker throws
an error THEN BullMQ retries the job an unbounded number of times, re-running `fullSync()`
from scratch on each attempt.

1.5 WHEN a full sync job is retried without an `attempts` limit THEN `ChaseEngineService`
emits chase halt events for the same invoice IDs on every retry.

---

### Expected Behavior (Correct)

2.1 WHEN a sync job has been removed from Redis AND `getJobStatus(jobId)` is called THEN
the system SHALL fall back to querying the SyncLog document by its stored `jobId` reference
and return the terminal status recorded there (`'completed'`, `'partial'`, or `'failed'`).

2.2 WHEN the SyncLog fallback is used AND the SyncLog status is `'completed'` or
`'partial'` or `'failed'` THEN the system SHALL return that status so the frontend
terminates its poll loop.

2.3 WHEN a sync job finishes with non-empty errors THEN `getJobStatus()` SHALL return
`'partial'` as the status so the frontend recognises it as a terminal outcome.

2.4 WHEN `dispatchFullSync` enqueues a BullMQ job THEN the system SHALL set `attempts: 3`
(or another explicit finite cap) on the job options to bound the number of automatic
retries.

2.5 WHEN a full sync job has exhausted its retry attempts THEN BullMQ SHALL move the job
to the failed state and stop re-processing it, preventing duplicate chase engine events.

---

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a sync job is still active in Redis AND `getJobStatus(jobId)` is called THEN the
system SHALL CONTINUE TO return the live BullMQ job state (`'waiting'`, `'active'`,
`'completed'`, `'failed'`) as it does today.

3.2 WHEN a sync job is `'failed'` in BullMQ AND `getJobStatus(jobId)` is called THEN the
system SHALL CONTINUE TO return `{ status: 'failed', failedReason: ... }`.

3.3 WHEN a sync job succeeds with zero errors THEN `getJobStatus()` SHALL CONTINUE TO
return `'completed'`.

3.4 WHEN a job ID is not recognised by BullMQ AND no SyncLog exists for it THEN the system
SHALL CONTINUE TO return `{ status: 'unknown', progress: 0 }`.

3.5 WHEN `dispatchIncrementalSync` enqueues a job THEN its retry behaviour SHALL CONTINUE
TO be unaffected by the fix to `dispatchFullSync`.

3.6 WHEN a manual sync is triggered via `POST /integrations/connections/:id/sync` THEN the
system SHALL CONTINUE TO return `{ jobId, syncLogId }` in the response.

---

## Bug Condition Pseudocode

### Bug 1 — Job-Removed Status Fallback

```pascal
FUNCTION isBugCondition_1(X)
  INPUT: X = { jobId: string, bullMQJob: Job | null }
  OUTPUT: boolean

  RETURN X.bullMQJob = null        // job was removed from Redis after completion
END FUNCTION

// Property: Fix Checking — status fallback
FOR ALL X WHERE isBugCondition_1(X) DO
  result ← getJobStatus'(X.jobId)
  ASSERT result.status IN { 'completed', 'partial', 'failed' }
  ASSERT result.status ≠ 'unknown'   // only unknown if SyncLog also absent
END FOR

// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition_1(X) DO
  ASSERT getJobStatus(X.jobId) = getJobStatus'(X.jobId)
END FOR
```

### Bug 2 — Bounded Retries

```pascal
FUNCTION isBugCondition_2(X)
  INPUT: X = { jobOptions: BullMQJobOptions }
  OUTPUT: boolean

  RETURN X.jobOptions.attempts = undefined   // no explicit retry cap
END FUNCTION

// Property: Fix Checking — attempts cap
FOR ALL X WHERE isBugCondition_2(X) DO
  opts ← dispatchFullSync'(...)
  ASSERT opts.attempts ≤ 5   // explicit finite limit present
END FOR

// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition_2(X) DO
  ASSERT dispatchFullSync(X) = dispatchFullSync'(X)
END FOR
```
