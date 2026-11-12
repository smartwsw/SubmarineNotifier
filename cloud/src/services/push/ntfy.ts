import type { PushMessage, PushResult, PushTarget } from '../../models/index.js';
import { describeHttpError, fetchWithTimeout, trimTrailingSlash, type PushProvider, type ValidationResult } from './provider.js';

const DEFAULT_SERVER = 'https://ntfy.sh';
const PRIORITY_MAP: Record<string, string> = {
  min: 'min',
  low: 'low',
  default: 'default',
  high: 'high',
  urgent: 'urgent',
  max: 'urgent',
};

export class NtfyProvider implements PushProvider {
  getProviderName(): string {
    return 'ntfy';
  }

  validateConfiguration(target: PushTarget): ValidationResult {
    if (!target.topic) return { valid: false, reason: 'topic_required' };
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(target.topic)) return { valid: false, reason: 'invalid_topic' };
    if (!target.serverUrl) return { valid: false, reason: 'server_url_required' };
    return { valid: true };
  }

  async sendNotification(message: PushMessage, target: PushTarget, timeoutMs = 10_000): Promise<PushResult> {
    const started = Date.now();
    const server = trimTrailingSlash(target.serverUrl || DEFAULT_SERVER);
    const topic = target.topic || message.topic;

    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
    };
    // 含非 ASCII 字符时改用 RFC 2047 编码，避免部分运行时拒绝非 ASCII 头
    headers.Title = /^[\x20-\x7E]*$/.test(message.title) ? message.title : encodeRfc2047(message.title);
    const priority = PRIORITY_MAP[message.priority] ?? 'default';
    headers.Priority = priority;
    if (message.group) headers.Tags = message.group;
    if (message.clickUrl) headers.Click = message.clickUrl;
    if (target.token) headers.Authorization = `Bearer ${target.token}`;

    const response = await fetchWithTimeout(
      `${server}/${encodeURIComponent(topic)}`,
      { method: 'POST', headers, body: message.body },
      timeoutMs,
    );

    const text = await response.text();
    const latencyMs = Date.now() - started;
    if (!response.ok) throw describeHttpError(response.status, text);

    return { delivered: true, provider: 'ntfy', latencyMs, statusCode: response.status };
  }

  async testNotification(target: PushTarget, timeoutMs = 10_000): Promise<PushResult> {
    return this.sendNotification(
      {
        title: 'Submarine Notifier 测试',
        body: '如果你看到这条通知，说明 ntfy 配置正确。',
        group: '',
        sound: '',
        icon: '',
        priority: 'default',
        topic: target.topic,
      },
      target,
      timeoutMs,
    );
  }
}

function encodeRfc2047(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}
