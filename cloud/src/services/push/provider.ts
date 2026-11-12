import type { PushMessage, PushResult, PushTarget } from '../../models/index.js';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export interface PushProvider {
  getProviderName(): string;
  validateConfiguration(target: PushTarget): ValidationResult;
  sendNotification(message: PushMessage, target: PushTarget, timeoutMs?: number): Promise<PushResult>;
  testNotification(target: PushTarget, timeoutMs?: number): Promise<PushResult>;
}

export class PushError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 解析推送服务的错误响应，做长度与敏感信息截断 */
export function describeHttpError(status: number, bodyText: string): PushError {
  const retryable = status === 429 || status >= 500;
  const snippet = bodyText.replace(/\s+/g, ' ').trim().slice(0, 200);
  return new PushError(`HTTP ${status}${snippet ? `: ${snippet}` : ''}`, status, retryable);
}
