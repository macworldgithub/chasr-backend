// src/connectors/xero/xero-rate-limiter.ts
import { Logger } from '@nestjs/common';

const logger = new Logger('XeroRateLimiter');

// Xero's limit: 60 calls/minute per app per tenant.
// When we hit it, they return HTTP 429 with a Retry-After header (seconds).
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000; // 1 second base delay

/**
 * Wraps any Xero API call with automatic 429 rate-limit retry.
 *
 * How it works:
 *  1. Execute the provided function.
 *  2. If Xero returns 429, read the Retry-After header (or use exponential backoff).
 *  3. Sleep that duration, then retry — up to MAX_RETRIES times.
 *  4. If all retries fail, re-throw the last error so BullMQ can handle it.
 *
 * Usage:
 *   const resp = await withRateLimit(() => xero.accountingApi.getInvoices(...));
 */
export async function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;

      // Detect Xero's rate limit response:
      // The xero-node SDK wraps the Axios error — status is on err.response?.status
      const status =
        err?.response?.status ?? err?.statusCode ?? err?.status;

      if (status !== 429) {
        // Not a rate limit error — rethrow immediately
        throw err;
      }

      if (attempt === MAX_RETRIES) {
        // Exhausted all retries
        logger.error(`Xero rate limit hit after ${MAX_RETRIES} retries — giving up`);
        throw err;
      }

      // Read Retry-After header (Xero sends seconds as a number)
      const retryAfterHeader =
        err?.response?.headers?.['retry-after'] ??
        err?.response?.headers?.['Retry-After'];

      const waitMs = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : BASE_BACKOFF_MS * Math.pow(2, attempt); // exponential: 1s, 2s, 4s

      logger.warn(
        `Xero 429 rate limit hit (attempt ${attempt + 1}/${MAX_RETRIES}). Waiting ${waitMs}ms before retry...`,
      );

      await sleep(waitMs);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
