import type {
  ApiTokenRow,
  BatchItemRow,
  BatchRow,
  DeviceRow,
  NotificationLogRow,
  ProviderKind,
  SubmarineRow,
  UserSettingsRow,
} from '../models/index.js';
import { newId } from '../utils/crypto.js';

export interface UserSettings {
  mergeWindowMinutes: number;
  advanceNotificationMinutes: number;
  notificationEnabled: boolean;
  provider: ProviderKind;
  providerServerUrl: string;
  providerTokenEnc: string;
  providerTopic: string;
  notifyTitle: string;
  notifyBodyTemplate: string;
  notifyGroup: string;
  notifySound: string;
  notifyIcon: string;
  notifyPriority: string;
  timezone: string;
  updatedAt: number;
}

export const DEFAULT_SETTINGS: UserSettings = {
  mergeWindowMinutes: 10,
  advanceNotificationMinutes: 5,
  notificationEnabled: true,
  provider: 'bark',
  providerServerUrl: 'https://api.day.app',
  providerTokenEnc: '',
  providerTopic: '',
  notifyTitle: '潜水艇返航',
  notifyBodyTemplate: '',
  notifyGroup: 'FF14',
  notifySound: '',
  notifyIcon: '',
  notifyPriority: 'default',
  timezone: 'UTC',
  updatedAt: 0,
};

export function mapSettings(row: UserSettingsRow | null): UserSettings {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    mergeWindowMinutes: row.merge_window_minutes,
    advanceNotificationMinutes: row.advance_notification_minutes,
    notificationEnabled: row.notification_enabled === 1,
    provider: row.provider,
    providerServerUrl: row.provider_server_url,
    providerTokenEnc: row.provider_token_enc,
    providerTopic: row.provider_topic,
    notifyTitle: row.notify_title,
    notifyBodyTemplate: row.notify_body_template,
    notifyGroup: row.notify_group,
    notifySound: row.notify_sound,
    notifyIcon: row.notify_icon,
    notifyPriority: row.notify_priority,
    timezone: row.timezone,
    updatedAt: row.updated_at,
  };
}

export class Repository {
  constructor(private readonly db: D1Database) {}

  // ---------------- users / devices / tokens ----------------

  async createUser(now: number): Promise<string> {
    const id = newId('usr');
    await this.db
      .prepare('INSERT INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, ?)')
      .bind(id, now, now, 'active')
      .run();
    return id;
  }

  async getUser(userId: string): Promise<{ id: string; status: string } | null> {
    return this.db.prepare('SELECT id, status FROM users WHERE id = ?').bind(userId).first<{ id: string; status: string }>();
  }

  async deleteUser(userId: string): Promise<void> {
    await this.db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  }

  async createDevice(userId: string, name: string, now: number): Promise<string> {
    const id = newId('dev');
    await this.db
      .prepare('INSERT INTO devices (id, user_id, device_name, created_at, last_seen_at, status) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, userId, name, now, now, 'active')
      .run();
    return id;
  }

  async listDevices(userId: string): Promise<Omit<DeviceRow, 'user_id'>[]> {
    const result = await this.db
      .prepare('SELECT id, device_name, created_at, last_seen_at, status FROM devices WHERE user_id = ? ORDER BY created_at ASC')
      .bind(userId)
      .all<Omit<DeviceRow, 'user_id'>>();
    return result.results ?? [];
  }

  async revokeDevice(userId: string, deviceId: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE devices SET status = 'revoked' WHERE id = ? AND user_id = ? AND status = 'active'")
      .bind(deviceId, userId)
      .run();
    if (!result.meta.changes) return false;
    await this.db
      .prepare('UPDATE api_tokens SET revoked_at = ? WHERE device_id = ? AND user_id = ? AND revoked_at IS NULL')
      .bind(now, deviceId, userId)
      .run();
    return true;
  }

  async createToken(params: {
    userId: string;
    deviceId: string | null;
    tokenHash: string;
    tokenPrefix: string;
    now: number;
    expiresAt: number | null;
    rotatedFrom?: string | null;
  }): Promise<string> {
    const id = newId('tok');
    await this.db
      .prepare(
        `INSERT INTO api_tokens (id, user_id, device_id, token_hash, token_prefix, created_at, expires_at, rotated_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        params.userId,
        params.deviceId,
        params.tokenHash,
        params.tokenPrefix,
        params.now,
        params.expiresAt,
        params.rotatedFrom ?? null,
      )
      .run();
    return id;
  }

  async findTokenByHash(tokenHash: string): Promise<ApiTokenRow | null> {
    return this.db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').bind(tokenHash).first<ApiTokenRow>();
  }

  async touchToken(tokenId: string, deviceId: string | null, now: number): Promise<void> {
    await this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').bind(now, tokenId).run();
    if (deviceId) {
      await this.db
        .prepare('UPDATE devices SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?')
        .bind(now, deviceId, now - 60)
        .run();
    }
  }

  async revokeToken(tokenId: string, now: number): Promise<void> {
    await this.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').bind(now, tokenId).run();
  }

  // ---------------- settings ----------------

  async getSettings(userId: string): Promise<UserSettings> {
    const row = await this.db.prepare('SELECT * FROM user_settings WHERE user_id = ?').bind(userId).first<UserSettingsRow>();
    return mapSettings(row);
  }

  async saveSettings(userId: string, settings: UserSettings, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO user_settings (
           user_id, merge_window_minutes, advance_notification_minutes, notification_enabled,
           provider, provider_server_url, provider_token_enc, provider_topic,
           notify_title, notify_body_template, notify_group, notify_sound, notify_icon,
           notify_priority, timezone, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           merge_window_minutes = excluded.merge_window_minutes,
           advance_notification_minutes = excluded.advance_notification_minutes,
           notification_enabled = excluded.notification_enabled,
           provider = excluded.provider,
           provider_server_url = excluded.provider_server_url,
           provider_token_enc = excluded.provider_token_enc,
           provider_topic = excluded.provider_topic,
           notify_title = excluded.notify_title,
           notify_body_template = excluded.notify_body_template,
           notify_group = excluded.notify_group,
           notify_sound = excluded.notify_sound,
           notify_icon = excluded.notify_icon,
           notify_priority = excluded.notify_priority,
           timezone = excluded.timezone,
           updated_at = excluded.updated_at`,
      )
      .bind(
        userId,
        settings.mergeWindowMinutes,
        settings.advanceNotificationMinutes,
        settings.notificationEnabled ? 1 : 0,
        settings.provider,
        settings.providerServerUrl,
        settings.providerTokenEnc,
        settings.providerTopic,
        settings.notifyTitle,
        settings.notifyBodyTemplate,
        settings.notifyGroup,
        settings.notifySound,
        settings.notifyIcon,
        settings.notifyPriority,
        settings.timezone,
        now,
      )
      .run();
  }

  // ---------------- submarines ----------------

  async listActiveSubmarines(userId: string): Promise<SubmarineRow[]> {
    const result = await this.db
      .prepare('SELECT * FROM submarines WHERE user_id = ? AND active = 1 ORDER BY character_id, slot_index')
      .bind(userId)
      .all<SubmarineRow>();
    return result.results ?? [];
  }

  /** 含已停用的行：同步时判断新旧必须能看到被删除槽位的采集时刻。 */
  async listAllSubmarines(userId: string): Promise<SubmarineRow[]> {
    const result = await this.db
      .prepare('SELECT * FROM submarines WHERE user_id = ? ORDER BY character_id, slot_index')
      .bind(userId)
      .all<SubmarineRow>();
    return result.results ?? [];
  }

  async findSubmarine(userId: string, characterId: string, slotIndex: number): Promise<SubmarineRow | null> {
    return this.db
      .prepare('SELECT * FROM submarines WHERE user_id = ? AND character_id = ? AND slot_index = ?')
      .bind(userId, characterId, slotIndex)
      .first<SubmarineRow>();
  }

  async upsertSubmarine(params: {
    userId: string;
    characterId: string;
    characterName: string;
    worldId: number | null;
    slotIndex: number;
    name: string;
    state: string;
    returnAt: number;
    rank: number;
    routePoints: string;
    parts: string;
    collectedAt: number;
    now: number;
    existingId?: string;
    active: boolean;
  }): Promise<string> {
    const id = params.existingId ?? newId('sub');
    await this.db
      .prepare(
        `INSERT INTO submarines (
           id, user_id, character_id, character_name, world_id, slot_index, submarine_name, state,
           return_at, rank, route_points, parts, collected_at, last_uploaded_at, updated_at, active
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, character_id, slot_index) DO UPDATE SET
           character_name = excluded.character_name,
           world_id = excluded.world_id,
           submarine_name = excluded.submarine_name,
           state = excluded.state,
           return_at = excluded.return_at,
           rank = excluded.rank,
           route_points = excluded.route_points,
           parts = excluded.parts,
           collected_at = excluded.collected_at,
           last_uploaded_at = excluded.last_uploaded_at,
           updated_at = excluded.updated_at,
           active = excluded.active`,
      )
      .bind(
        id,
        params.userId,
        params.characterId,
        params.characterName,
        params.worldId,
        params.slotIndex,
        params.name,
        params.state,
        params.returnAt,
        params.rank,
        params.routePoints,
        params.parts,
        params.collectedAt,
        params.now,
        params.now,
        params.active ? 1 : 0,
      )
      .run();
    return id;
  }

  /**
   * 停用本次没出现的槽位。
   *
   * `collectedAt` 是"观察到它已不存在"的采集时刻，写进 collected_at：
   * 旧设备拿旧快照回来时，靠这个时刻才能判断出"库里看到的更晚"，从而不会把槽位重新激活。
   */
  async deactivateSubmarinesNotIn(
    userId: string,
    characterId: string,
    slotIndexes: number[],
    now: number,
    collectedAt: number,
  ): Promise<void> {
    if (slotIndexes.length === 0) {
      await this.db
        .prepare(
          `UPDATE submarines SET active = 0, collected_at = ?, updated_at = ?
           WHERE user_id = ? AND character_id = ? AND active = 1`,
        )
        .bind(collectedAt, now, userId, characterId)
        .run();
      return;
    }
    const placeholders = slotIndexes.map(() => '?').join(',');
    await this.db
      .prepare(
        `UPDATE submarines SET active = 0, collected_at = ?, updated_at = ?
         WHERE user_id = ? AND character_id = ? AND active = 1 AND slot_index NOT IN (${placeholders})`,
      )
      .bind(collectedAt, now, userId, characterId, ...slotIndexes)
      .run();
  }

  /**
   * 用户显式删除一艘潜水艇。
   *
   * 同样把 collected_at 设为 `now`：删除是可判定的最新事实，
   * 之后任何采集时刻更早的旧快照都不能把它复活。
   */
  async deactivateSubmarine(userId: string, submarineId: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        'UPDATE submarines SET active = 0, collected_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND active = 1',
      )
      .bind(now, now, submarineId, userId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  // ---------------- batches ----------------

  async listPendingBatches(userId: string): Promise<BatchRow[]> {
    const result = await this.db
      .prepare("SELECT * FROM notification_batches WHERE user_id = ? AND status = 'pending' ORDER BY notify_at ASC")
      .bind(userId)
      .all<BatchRow>();
    return result.results ?? [];
  }

  async listBatchItems(batchId: string): Promise<BatchItemRow[]> {
    // 固定排序：通知正文里的艘次顺序必须稳定（D1 无 ORDER BY 时顺序不保证）
    const result = await this.db
      .prepare('SELECT * FROM notification_batch_items WHERE batch_id = ? ORDER BY return_at ASC, submarine_id ASC')
      .bind(batchId)
      .all<BatchItemRow>();
    return result.results ?? [];
  }

  async createBatch(params: {
    userId: string;
    anchorReturnAt: number;
    latestReturnAt: number;
    notifyAt: number;
    advanceNotifyAt: number | null;
    now: number;
  }): Promise<string> {
    const id = newId('bat');
    await this.db
      .prepare(
        `INSERT INTO notification_batches
           (id, user_id, anchor_return_at, latest_return_at, notify_at, advance_notify_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(id, params.userId, params.anchorReturnAt, params.latestReturnAt, params.notifyAt, params.advanceNotifyAt, params.now, params.now)
      .run();
    return id;
  }

  async addBatchItem(batchId: string, submarineId: string, returnAt: number): Promise<void> {
    await this.db
      .prepare('INSERT OR IGNORE INTO notification_batch_items (batch_id, submarine_id, return_at) VALUES (?, ?, ?)')
      .bind(batchId, submarineId, returnAt)
      .run();
  }

  async cancelPendingBatches(userId: string, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM notification_batch_items WHERE batch_id IN
             (SELECT id FROM notification_batches WHERE user_id = ? AND status = 'pending')`,
        )
        .bind(userId),
      this.db
        .prepare("UPDATE notification_batches SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND status = 'pending'")
        .bind(now, userId),
    ]);
  }

  /**
   * 已成功发送（含正在发送）的通知事件键。
   * 事件键按"潜艇 + 返航时间"维度记录，因此批次重算不会导致重复推送。
   */
  async listEventKeys(userId: string): Promise<Set<string>> {
    const result = await this.db
      .prepare("SELECT event_key FROM notification_logs WHERE user_id = ? AND status IN ('sending','sent')")
      .bind(userId)
      .all<{ event_key: string }>();
    return new Set((result.results ?? []).map((row) => row.event_key));
  }

  async cancelBatch(batchId: string, now: number): Promise<void> {
    await this.db
      .prepare("UPDATE notification_batches SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'")
      .bind(now, batchId)
      .run();
  }

  async markBatchAdvanced(batchId: string, now: number): Promise<void> {
    await this.db
      .prepare('UPDATE notification_batches SET advanced_sent_at = ?, updated_at = ? WHERE id = ?')
      .bind(now, now, batchId)
      .run();
  }

  async markBatchSent(batchId: string, now: number): Promise<void> {
    await this.db
      .prepare("UPDATE notification_batches SET status = 'sent', sent_at = ?, next_retry_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?")
      .bind(now, now, batchId)
      .run();
  }

  async recordBatchFailure(batchId: string, attempts: number, nextRetryAt: number | null, message: string, now: number): Promise<void> {
    await this.db
      .prepare('UPDATE notification_batches SET attempt_count = ?, next_retry_at = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .bind(attempts, nextRetryAt, message.slice(0, 500), now, batchId)
      .run();
  }

  /** 达到最大重试次数：批次保持 pending 但放弃重试（明确记录 failed 状态） */
  async markBatchFailed(batchId: string, attempts: number, message: string, now: number): Promise<void> {
    await this.db
      .prepare(
        "UPDATE notification_batches SET status = 'failed', attempt_count = ?, next_retry_at = NULL, last_error = ?, updated_at = ? WHERE id = ?",
      )
      .bind(attempts, message.slice(0, 500), now, batchId)
      .run();
  }

  async deleteLog(logId: string): Promise<void> {
    await this.db.prepare('DELETE FROM notification_logs WHERE id = ?').bind(logId).run();
  }

  async getBatch(batchId: string, userId: string): Promise<BatchRow | null> {
    return this.db
      .prepare('SELECT * FROM notification_batches WHERE id = ? AND user_id = ?')
      .bind(batchId, userId)
      .first<BatchRow>();
  }

  // ---------------- logs ----------------

  /**
   * 幂等写入日志：event_key 已存在时返回 null（表示已处理过）。
   */
  async tryInsertLog(params: {
    userId: string;
    batchId: string | null;
    eventType: string;
    eventKey: string;
    status: string;
    provider: string;
    now: number;
  }): Promise<string | null> {
    const id = newId('log');
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO notification_logs
           (id, user_id, batch_id, event_type, event_key, status, provider, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .bind(id, params.userId, params.batchId, params.eventType, params.eventKey, params.status, params.provider, params.now)
      .run();
    return (result.meta.changes ?? 0) > 0 ? id : null;
  }

  async updateLog(logId: string, status: string, errorMessage: string | null): Promise<void> {
    await this.db
      .prepare('UPDATE notification_logs SET status = ?, error_message = ? WHERE id = ?')
      .bind(status, errorMessage?.slice(0, 500) ?? null, logId)
      .run();
  }

  async listLogs(userId: string, limit: number, eventType?: string): Promise<NotificationLogRow[]> {
    if (eventType) {
      const result = await this.db
        .prepare('SELECT * FROM notification_logs WHERE user_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT ?')
        .bind(userId, eventType, limit)
        .all<NotificationLogRow>();
      return result.results ?? [];
    }
    const result = await this.db
      .prepare('SELECT * FROM notification_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .bind(userId, limit)
      .all<NotificationLogRow>();
    return result.results ?? [];
  }

  // ---------------- rate limiting / dedup / cleanup ----------------

  async incrementRateLimit(key: string, windowSeconds: number, now: number): Promise<number> {
    await this.db
      .prepare(
        `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET count = count + 1`,
      )
      .bind(key, now + windowSeconds)
      .run();
    const row = await this.db.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(key).first<{ count: number }>();
    return row?.count ?? 1;
  }

  async isDuplicateSync(hash: string, now: number): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT hash FROM sync_dedup WHERE hash = ? AND created_at > ?')
      .bind(hash, now - 7 * 86400)
      .first<{ hash: string }>();
    return row !== null;
  }

  async recordSyncHash(hash: string, userId: string, now: number): Promise<void> {
    await this.db
      .prepare('INSERT OR IGNORE INTO sync_dedup (hash, user_id, created_at) VALUES (?, ?, ?)')
      .bind(hash, userId, now)
      .run();
  }

  async cleanup(now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now),
      this.db.prepare('DELETE FROM sync_dedup WHERE created_at < ?').bind(now - 7 * 86400),
      this.db.prepare("DELETE FROM notification_logs WHERE created_at < ?").bind(now - 90 * 86400),
      this.db.prepare("DELETE FROM notification_batches WHERE status IN ('sent','cancelled','failed') AND created_at < ?").bind(now - 90 * 86400),
    ]);
  }
}
