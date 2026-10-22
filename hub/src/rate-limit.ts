/**
 * In-memory fixed-window rate limiter, keyed by client IP.
 *
 * Used for credential endpoints (auth.login / auth.register): 10 requests per
 * IP per 60s window. State lives in this process only — restart resets buckets.
 */

export interface RateDecision {
  allowed: boolean;
  /** Seconds until the current window resets (set when not allowed). */
  retryAfterSec: number;
}

export class RateLimiter {
  private buckets = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  take(key: string, now = Date.now()): RateDecision {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      if (this.buckets.size > 10_000) this.sweep(now);
      return { allowed: true, retryAfterSec: 0 };
    }
    bucket.count += 1;
    if (bucket.count > this.max) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((bucket.windowStart + this.windowMs - now) / 1000)),
      };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) this.buckets.delete(key);
    }
  }
}
