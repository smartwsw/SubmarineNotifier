import type { Env } from '../index.js';
import { Repository } from '../storage/repository.js';
import { ApiError } from '../utils/http.js';

/**
 * 固定窗口限流（D1 计数表）。
 * 超限抛 429，附带 Retry-After。
 */
export async function checkRateLimit(env: Env, key: string, limit: number, windowSeconds: number, now: number): Promise<void> {
  const bucket = Math.floor(now / windowSeconds);
  const fullKey = `${key}:${bucket}`;
  const repo = new Repository(env.DB);
  const count = await repo.incrementRateLimit(fullKey, windowSeconds * 2, now);
  if (count > limit) {
    const retryAfter = windowSeconds - (now % windowSeconds);
    throw new ApiError(429, 'RATE_LIMITED', 'Too many requests', { 'Retry-After': String(retryAfter) });
  }
}
