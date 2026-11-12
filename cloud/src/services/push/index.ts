import type { ProviderKind, PushResult, PushTarget } from '../../models/index.js';
import { BarkProvider } from './bark.js';
import { NtfyProvider } from './ntfy.js';
import { PushError, type PushProvider } from './provider.js';

export type { PushProvider } from './provider.js';
export { PushError } from './provider.js';

const providers: Record<string, PushProvider> = {
  bark: new BarkProvider(),
  ntfy: new NtfyProvider(),
};

export function getProvider(kind: ProviderKind): PushProvider | null {
  return providers[kind] ?? null;
}

export function listProviderNames(): string[] {
  return Object.keys(providers);
}

export { BarkProvider } from './bark.js';
export { NtfyProvider } from './ntfy.js';

export interface DispatchResult {
  result: PushResult;
  retryable: boolean;
}

/**
 * 执行一次发送并归一化异常：
 * 网络错误可重试，4xx（除 429）不可重试。
 */
export async function dispatch(
  kind: ProviderKind,
  message: Parameters<PushProvider['sendNotification']>[0],
  target: PushTarget,
  timeoutMs = 10_000,
): Promise<DispatchResult> {
  const provider = getProvider(kind);
  if (!provider) throw new PushError(`unknown provider: ${kind}`, undefined, false);
  const validation = provider.validateConfiguration(target);
  if (!validation.valid) throw new PushError(`invalid configuration: ${validation.reason}`, undefined, false);

  try {
    const result = await provider.sendNotification(message, target, timeoutMs);
    return { result, retryable: false };
  } catch (error) {
    if (error instanceof PushError) {
      return {
        result: { delivered: false, provider: kind, latencyMs: 0, error: error.message, statusCode: error.statusCode },
        retryable: error.retryable,
      };
    }
    const messageText = error instanceof Error ? error.message : 'network error';
    return {
      result: { delivered: false, provider: kind, latencyMs: 0, error: messageText.slice(0, 200) },
      retryable: true,
    };
  }
}
