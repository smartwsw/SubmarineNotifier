import type { PushMessage, PushResult, PushTarget } from '../../models/index.js';
import { describeHttpError, fetchWithTimeout, trimTrailingSlash, type PushProvider, type ValidationResult } from './provider.js';

const DEFAULT_SERVER = 'https://api.day.app';
const LEVELS = new Set(['critical', 'active', 'timeSensitive', 'passive']);

export class BarkProvider implements PushProvider {
  getProviderName(): string {
    return 'bark';
  }

  validateConfiguration(target: PushTarget): ValidationResult {
    if (!target.token) return { valid: false, reason: 'device_key_required' };
    if (!target.serverUrl) return { valid: false, reason: 'server_url_required' };
    return { valid: true };
  }

  async sendNotification(message: PushMessage, target: PushTarget, timeoutMs = 10_000): Promise<PushResult> {
    const started = Date.now();
    const server = trimTrailingSlash(target.serverUrl || DEFAULT_SERVER);

    const payload: Record<string, unknown> = {
      device_key: target.token,
      title: message.title,
      body: message.body,
    };
    if (message.group) payload.group = message.group;
    if (message.sound) payload.sound = message.sound;
    if (message.icon) payload.icon = message.icon;
    if (message.clickUrl) payload.url = message.clickUrl;
    if (LEVELS.has(message.priority)) payload.level = message.priority;

    const response = await fetchWithTimeout(
      `${server}/push`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
      },
      timeoutMs,
    );

    const text = await response.text();
    const latencyMs = Date.now() - started;

    if (!response.ok) throw describeHttpError(response.status, text);

    // Bark 服务端成功时返回 {"code":200,...}；若返回非 JSON 则以 2xx 视为成功
    try {
      const parsed = JSON.parse(text) as { code?: number; message?: string };
      if (typeof parsed.code === 'number' && parsed.code !== 200) {
        throw describeHttpError(parsed.code, parsed.message ?? '');
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }

    return { delivered: true, provider: 'bark', latencyMs, statusCode: response.status };
  }

  async testNotification(target: PushTarget, timeoutMs = 10_000): Promise<PushResult> {
    return this.sendNotification(
      {
        title: 'Submarine Notifier 测试',
        body: '如果你看到这条通知，说明 Bark 配置正确。',
        group: 'FF14',
        sound: '',
        icon: '',
        priority: 'active',
        topic: '',
      },
      target,
      timeoutMs,
    );
  }
}
