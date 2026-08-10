export class RetryableError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries fn with exponential backoff. Only RetryableError is retried —
 * a 4xx from an external API is a permanent failure and retrying it just
 * burns the function's execution budget.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { attempts: number; baseDelayMs?: number; onRetry?: (attempt: number, err: Error) => void },
): Promise<T> {
  const base = opts.baseDelayMs ?? 400;
  let lastError: Error = new Error('no attempts made');

  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!(err instanceof RetryableError) || attempt === opts.attempts) {
        throw lastError;
      }
      opts.onRetry?.(attempt, lastError);
      await sleep(base * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}

/** Classifies an HTTP status: 5xx and 429 are worth retrying, 4xx is not. */
export function throwForStatus(status: number, body: string): void {
  if (status >= 200 && status < 300) return;
  const message = `HTTP ${status}: ${body.slice(0, 500)}`;
  if (status >= 500 || status === 429 || status === 408) {
    throw new RetryableError(message);
  }
  throw new Error(message);
}
