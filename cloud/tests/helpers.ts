import { env } from 'cloudflare:test';
import { handleRequest } from '../src/index.js';
import { encryptSecret } from '../src/utils/crypto.js';
import type { BatchRow, NotificationLogRow } from '../src/models/index.js';

export interface ApiResponse<T = any> {
  ok: boolean;
  data: T;
  error?: { code: string; message: string };
  requestId?: string;
}

/**
 * 直接调用 Worker fetch handler（而不是 SELF.fetch），
 * 这样测试内对 globalThis.fetch 的桩可以作用于推送请求，而不会拦截测试自身请求。
 */
export async function api(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: ApiResponse }> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  const response = await handleRequest(
    new Request(`https://example.com/api/v1${path}`, { ...init, headers }),
    env,
  );
  const text = await response.text();
  const body = text ? (JSON.parse(text) as ApiResponse) : ({ ok: response.status < 400, data: null } as ApiResponse);
  return { status: response.status, body };
}

export interface RegisteredUser {
  userId: string;
  token: string;
  deviceId: string;
}

export async function register(deviceName = '测试设备'): Promise<RegisteredUser> {
  const { status, body } = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ deviceName }),
  });
  if (status !== 201) throw new Error(`register failed: ${status} ${JSON.stringify(body)}`);
  return { userId: body.data.userId, token: body.data.token, deviceId: body.data.deviceId };
}

/** 直接把推送配置写入 D1（token 加密存储），用于不经过 API 的调度/投递测试 */
export async function configurePush(
  userId: string,
  options: {
    provider?: 'bark' | 'ntfy';
    serverUrl?: string;
    token?: string;
    topic?: string;
    mergeWindowMinutes?: number;
    advanceNotificationMinutes?: number;
    notificationEnabled?: boolean;
    timezone?: string;
  } = {},
): Promise<void> {
  const provider = options.provider ?? 'bark';
  const token = options.token ?? 'test-device-key';
  const encrypted = await encryptSecret(token, env.SECRETS_KEY, userId);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO user_settings (
       user_id, merge_window_minutes, advance_notification_minutes, notification_enabled,
       provider, provider_server_url, provider_token_enc, provider_topic,
       notify_title, notify_body_template, notify_group, notify_sound, notify_icon,
       notify_priority, timezone, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '潜水艇返航', '', 'FF14', '', '', 'default', ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       merge_window_minutes = excluded.merge_window_minutes,
       advance_notification_minutes = excluded.advance_notification_minutes,
       notification_enabled = excluded.notification_enabled,
       provider = excluded.provider,
       provider_server_url = excluded.provider_server_url,
       provider_token_enc = excluded.provider_token_enc,
       provider_topic = excluded.provider_topic,
       timezone = excluded.timezone,
       updated_at = excluded.updated_at`,
  )
    .bind(
      userId,
      options.mergeWindowMinutes ?? 10,
      options.advanceNotificationMinutes ?? 0,
      (options.notificationEnabled ?? true) ? 1 : 0,
      provider,
      options.serverUrl ?? 'https://api.day.app',
      encrypted,
      options.topic ?? '',
      options.timezone ?? 'Asia/Shanghai',
      now,
    )
    .run();
}

export interface SyncSub {
  slotIndex: number;
  name?: string;
  rank?: number;
  returnAt: number;
  routePoints?: number[];
}

export function syncBody(characterId: string, submarines: SyncSub[], characterName = 'Test Character') {
  return {
    characterId,
    characterName,
    worldId: 1,
    collectedAt: Math.floor(Date.now() / 1000),
    clientTimeOffsetMs: 0,
    submarines: submarines.map((s) => ({
      slotIndex: s.slotIndex,
      name: s.name ?? `Sub${s.slotIndex}`,
      rank: s.rank ?? 90,
      returnAt: s.returnAt,
      routePoints: s.routePoints ?? [1, 2, 3],
      parts: { hull: 1, stern: 1, bow: 1, bridge: 1 },
      state: s.returnAt > 0 ? 'sailing' : 'docked',
    })),
  };
}

export async function listBatches(userId: string) {
  const result = await env.DB.prepare(
    `SELECT * FROM notification_batches WHERE user_id = ? AND status = 'pending' ORDER BY notify_at ASC`,
  )
    .bind(userId)
    .all<BatchRow>();
  return result.results ?? [];
}

export async function listBatchItemsWithNames(batchId: string) {
  const result = await env.DB.prepare(
    `SELECT i.*, s.submarine_name FROM notification_batch_items i
       JOIN submarines s ON s.id = i.submarine_id
       WHERE i.batch_id = ? ORDER BY i.return_at ASC`,
  )
    .bind(batchId)
    .all<{ submarine_id: string; return_at: number; submarine_name: string }>();
  return result.results ?? [];
}

export async function listLogs(userId: string) {
  const result = await env.DB.prepare(
    'SELECT * FROM notification_logs WHERE user_id = ? ORDER BY created_at ASC',
  )
    .bind(userId)
    .all<NotificationLogRow>();
  return result.results ?? [];
}
