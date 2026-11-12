import type { BatchItemRow, BatchRow, PushTarget, SubmarineRow } from '../models/index.js';
import { Repository, type UserSettings } from '../storage/repository.js';
import { eventKey, replan } from './scheduler-service.js';
import { formatNotification } from './notification-service.js';
import { dispatch, getProvider } from './push/index.js';
import { decryptSecret } from '../utils/crypto.js';
import { formatInTimeZone } from '../utils/time.js';
import { validatePushUrl } from '../utils/validation.js';

export const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_SECONDS = [60, 120, 240, 480, 960];

const DEFAULT_SERVER: Record<string, string> = {
  bark: 'https://api.day.app',
  ntfy: 'https://ntfy.sh',
};

export interface DeliveryEnv {
  repository: Repository;
  secretsKey: string;
  environment: string;
  allowHttpPushHosts: readonly string[];
}

export interface DeliveryBindings {
  DB: D1Database;
  SECRETS_KEY: string;
  ENVIRONMENT: string;
  DEV_INSECURE_PUSH_HOSTS?: string;
}

/** 开发环境允许 http 推送主机（仅测试/本地调试使用） */
export function resolveAllowHttpHosts(bindings: { ENVIRONMENT: string; DEV_INSECURE_PUSH_HOSTS?: string }): string[] {
  if (bindings.ENVIRONMENT !== 'dev') return [];
  return (bindings.DEV_INSECURE_PUSH_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
}

export function deliveryEnv(bindings: DeliveryBindings, repository = new Repository(bindings.DB)): DeliveryEnv {
  return {
    repository,
    secretsKey: bindings.SECRETS_KEY,
    environment: bindings.ENVIRONMENT,
    allowHttpPushHosts: resolveAllowHttpHosts(bindings),
  };
}

export interface DeliveryOutcome {
  batchId: string;
  advanced: boolean;
  sent: boolean;
  skippedReason?: string;
  error?: string;
  retryScheduledAt?: number;
}

/** 从设置解析推送目标（解密凭据，仅在内存中使用） */
export async function resolvePushTarget(
  settings: UserSettings,
  secretsKey: string,
  userId: string,
  override?: { serverUrl?: string; token?: string; topic?: string; provider?: string },
): Promise<PushTarget | null> {
  const provider = (override?.provider ?? settings.provider) as PushTarget['provider'];
  if (provider === 'none') return null;

  const encrypted = settings.providerTokenEnc;
  const token = override?.token ?? (encrypted ? await decryptSecret(encrypted, secretsKey, userId) : '');
  const serverUrl = (override?.serverUrl ?? settings.providerServerUrl) || DEFAULT_SERVER[provider] || '';
  return {
    provider,
    serverUrl: serverUrl.replace(/\/+$/, ''),
    token,
    topic: override?.topic ?? settings.providerTopic,
  };
}

/** 提前通知的幂等键：同一用户同一通知时刻只发一次 */
export function advanceEventKey(userId: string, notifyAt: number): string {
  return `adv:${userId}:${notifyAt}`;
}

/**
 * 在发送前对推送 URL 做协议/主机校验并归一化。
 * 生产环境仅允许 https；dev 环境可通过白名单允许 http。
 */
export function sanitizePushTarget(env: DeliveryEnv, target: PushTarget): { ok: true; target: PushTarget } | { ok: false; reason: string } {
  const checked = validatePushUrl(target.serverUrl, env.allowHttpPushHosts, env.environment);
  if (!checked.ok || !checked.url) return { ok: false, reason: checked.reason ?? 'invalid_url' };
  return { ok: true, target: { ...target, serverUrl: checked.url.toString().replace(/\/+$/, '') } };
}

/** 批次成员 → 通知正文行 */
export function buildNoticeLines(
  items: readonly BatchItemRow[],
  submarines: readonly SubmarineRow[],
): Array<{ name: string; returnAt: number }> {
  const byId = new Map(submarines.map((s) => [s.id, s]));
  return items
    .map((item) => {
      const sub = byId.get(item.submarine_id);
      return { name: sub?.submarine_name || `潜水艇${sub?.slot_index ?? ''}`, returnAt: item.return_at };
    })
    // 按 UTF-16 码元排序（与插件预览的 StringComparer.Ordinal 一致），
    // 保证同秒返航的潜水艇在通知中的先后顺序稳定且可预测。
    .sort((a, b) => a.returnAt - b.returnAt || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 处理单个批次的所有到期动作（提前通知 / 正式通知 / 重试）。
 *
 * 幂等保证：
 *  - 每个“潜艇+返航时间”事件在 notification_logs 有唯一 event_key；
 *  - 发送前先 INSERT OR IGNORE，插入失败说明已被处理（并发/重复 alarm）。
 */
export async function processBatch(
  env: DeliveryEnv,
  userId: string,
  batch: BatchRow,
  settings: UserSettings,
  now: number,
): Promise<DeliveryOutcome> {
  const outcome: DeliveryOutcome = { batchId: batch.id, advanced: false, sent: false };
  if (batch.status !== 'pending') {
    outcome.skippedReason = `status_${batch.status}`;
    return outcome;
  }
  if (!settings.notificationEnabled) {
    outcome.skippedReason = 'notifications_disabled';
    return outcome;
  }

  const provider = getProvider(settings.provider);
  if (!provider) {
    outcome.skippedReason = 'provider_not_configured';
    return outcome;
  }

  const items = await env.repository.listBatchItems(batch.id);
  if (items.length === 0) {
    await env.repository.cancelBatch(batch.id, now);
    outcome.skippedReason = 'empty_batch';
    return outcome;
  }

  const submarines = await env.repository.listActiveSubmarines(userId);
  const lines = buildNoticeLines(items, submarines);

  // 退避期内不发送（DO 仍可能因其它批次被唤醒）
  if (batch.next_retry_at !== null && batch.next_retry_at > now) {
    outcome.skippedReason = 'retry_backoff';
    outcome.retryScheduledAt = batch.next_retry_at;
    return outcome;
  }

  let target: PushTarget;
  try {
    const resolved = await resolvePushTarget(settings, env.secretsKey, userId);
    if (!resolved) {
      outcome.skippedReason = 'provider_not_configured';
      return outcome;
    }
    const sanitized = sanitizePushTarget(env, resolved);
    if (!sanitized.ok) {
      outcome.skippedReason = `invalid_push_url_${sanitized.reason}`;
      return outcome;
    }
    target = sanitized.target;
  } catch {
    outcome.error = 'credentials_unavailable';
    return outcome;
  }

  const validation = provider.validateConfiguration(target);
  if (!validation.valid) {
    outcome.skippedReason = `invalid_configuration_${validation.reason ?? ''}`;
    return outcome;
  }

  // ---------- 提前通知 ----------
  if (batch.advance_notify_at !== null && batch.advanced_sent_at === null && batch.advance_notify_at <= now) {
    // 事件键绑定 (用户, notify_at) 而非 batchId：批次重算后同一通知时刻不会重复推送
    const advanceLogId = await env.repository.tryInsertLog({
      userId,
      batchId: batch.id,
      eventType: 'advance',
      eventKey: advanceEventKey(userId, batch.notify_at),
      status: 'sending',
      provider: settings.provider,
      now,
    });

    if (advanceLogId) {
      const text = formatNotification(
        { title: settings.notifyTitle, bodyTemplate: settings.notifyBodyTemplate },
        lines,
        'advance',
        settings.timezone,
        formatInTimeZone,
      );
      const delivered = await dispatch(
        settings.provider,
        {
          ...text,
          group: settings.notifyGroup,
          sound: settings.notifySound,
          icon: settings.notifyIcon,
          priority: settings.notifyPriority,
          topic: target.topic,
        },
        target,
      );

      if (delivered.result.delivered) {
        await env.repository.updateLog(advanceLogId, 'sent', null);
        await env.repository.markBatchAdvanced(batch.id, now);
        outcome.advanced = true;
      } else {
        // 提前通知失败不阻塞正式通知；删除日志，下次到期重试
        await env.repository.deleteLog(advanceLogId);
        outcome.error = delivered.result.error;
      }
    } else {
      // 已处理过（重复 alarm 重入）
      await env.repository.markBatchAdvanced(batch.id, now);
    }
  }

  // ---------- 正式通知 ----------
  if (batch.notify_at <= now) {
    const keys = items.map((item) => eventKey(item.submarine_id, item.return_at));
    const logIds: string[] = [];
    for (const key of keys) {
      const logId = await env.repository.tryInsertLog({
        userId,
        batchId: batch.id,
        eventType: 'returned',
        eventKey: key,
        status: 'sending',
        provider: settings.provider,
        now,
      });
      if (logId) logIds.push(logId);
    }

    if (logIds.length === 0) {
      // 该批次已全部发送过（重复 alarm / 重复执行）
      await env.repository.markBatchSent(batch.id, now);
      outcome.sent = true;
      outcome.skippedReason = 'already_delivered';
      return outcome;
    }

    const text = formatNotification(
      { title: settings.notifyTitle, bodyTemplate: settings.notifyBodyTemplate },
      lines,
      'returned',
      settings.timezone,
      formatInTimeZone,
    );
    const delivered = await dispatch(settings.provider, { ...text, group: settings.notifyGroup, sound: settings.notifySound, icon: settings.notifyIcon, priority: settings.notifyPriority, topic: target.topic }, target);

    if (delivered.result.delivered) {
      for (const logId of logIds) await env.repository.updateLog(logId, 'sent', null);
      await env.repository.markBatchSent(batch.id, now);
      outcome.sent = true;
      return outcome;
    }

    const attempts = batch.attempt_count + 1;
    const message = delivered.result.error ?? 'push failed';
    if (attempts >= MAX_ATTEMPTS || !delivered.retryable) {
      for (const logId of logIds) await env.repository.updateLog(logId, 'failed', message);
      await env.repository.markBatchFailed(batch.id, attempts, message, now);
      outcome.error = delivered.result.error;
      return outcome;
    }

    // 可重试：删除 sending 日志，下次重试时重新插入
    for (const logId of logIds) await env.repository.deleteLog(logId);
    const backoff = RETRY_BACKOFF_SECONDS[Math.min(attempts - 1, RETRY_BACKOFF_SECONDS.length - 1)] ?? 960;
    const retryAt = now + backoff;
    await env.repository.recordBatchFailure(batch.id, attempts, retryAt, delivered.result.error ?? '', now);
    outcome.error = delivered.result.error;
    outcome.retryScheduledAt = retryAt;
    return outcome;
  }

  return outcome;
}

export async function replanUser(
  env: DeliveryEnv,
  userId: string,
  settings: UserSettings,
  now: number,
): Promise<{ batches: number; events: number }> {
  return replan(env.repository, userId, settings, now);
}

// 供测试/调用方复用的导出
export { replan };
