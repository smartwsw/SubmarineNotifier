import type { Env } from '../index.js';
import { Repository, mapSettings } from '../storage/repository.js';
import { applySync } from '../services/submarine-service.js';
import { parseSyncRequest, isRecord } from '../utils/validation.js';
import { ApiError, ok, readJson } from '../utils/http.js';
import { checkRateLimit } from './rate-limit.js';
import type { AuthContext } from './auth.js';
import { deliveryEnv, replanUser } from '../services/delivery-service.js';
import { deriveState, nowSeconds } from '../utils/time.js';

async function notifyScheduler(env: Env, userId: string): Promise<void> {
  const id = env.SCHEDULER.idFromName(userId);
  const stub = env.SCHEDULER.get(id);
  await stub.fetch('https://scheduler/init', { method: 'POST', headers: { 'X-User-Id': userId } });
  await stub.fetch('https://scheduler/replan', { method: 'POST' });
}

export async function handleSync(request: Request, env: Env, auth: AuthContext, now: number): Promise<Response> {
  await checkRateLimit(env, `sync:${auth.userId}`, 60, 60, now);
  const body = await readJson(request);
  const { request: syncRequest, warnings } = parseSyncRequest(body);

  const repo = new Repository(env.DB);
  const outcome = await applySync(repo, auth.userId, syncRequest, now);

  // 整批陈旧时库里没有任何变化，重算只会做无用功
  if (outcome.changed > 0 || (outcome.deduped === false && !outcome.stale)) {
    const settings = await repo.getSettings(auth.userId);
    await replanUser(deliveryEnv(env, repo), auth.userId, settings, now);
    await notifyScheduler(env, auth.userId);
  }

  return ok({
    accepted: outcome.accepted,
    changed: outcome.changed,
    removed: outcome.removed,
    deduped: outcome.deduped,
    // 云端已存有更新的采集结果，本次未覆盖；插件应把这一状态提示给用户
    stale: outcome.stale,
    serverTime: now,
    warnings: [...warnings, ...outcome.warnings],
    nextSyncAfter: now + 60,
  });
}

export async function handleList(env: Env, auth: AuthContext, now: number): Promise<Response> {
  const repo = new Repository(env.DB);
  const rows = await repo.listActiveSubmarines(auth.userId);
  return ok({
    submarines: rows.map((row) => ({
      id: row.id,
      characterId: row.character_id,
      characterName: row.character_name,
      slotIndex: row.slot_index,
      name: row.submarine_name,
      state: deriveState(row.return_at, now),
      returnAt: row.return_at,
      remainingSeconds: row.return_at > 0 ? Math.max(0, row.return_at - now) : null,
      rank: row.rank,
      routePoints: safeJson<number[]>(row.route_points, []),
      updatedAt: row.updated_at,
    })),
    serverTime: now,
  });
}

export async function handleRemove(request: Request, env: Env, auth: AuthContext, now: number): Promise<Response> {
  const body = await readJson(request);
  const repo = new Repository(env.DB);
  let removed = 0;

  if (isRecord(body) && typeof body.submarineId === 'string') {
    removed = (await repo.deactivateSubmarine(auth.userId, body.submarineId, now)) ? 1 : 0;
    if (!removed) throw new ApiError(404, 'NOT_FOUND', 'Submarine not found');
  } else if (isRecord(body) && typeof body.characterId === 'string' && typeof body.slotIndex === 'number') {
    const row = await repo.findSubmarine(auth.userId, body.characterId, body.slotIndex);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Submarine not found');
    removed = (await repo.deactivateSubmarine(auth.userId, row.id, now)) ? 1 : 0;
  } else {
    throw new ApiError(400, 'VALIDATION_ERROR', 'submarineId or (characterId, slotIndex) required');
  }

  const settings = await repo.getSettings(auth.userId);
  await replanUser(deliveryEnv(env, repo), auth.userId, settings, now);
  await notifyScheduler(env, auth.userId);

  return ok({ removed });
}

export async function handleRefresh(env: Env, auth: AuthContext, now: number): Promise<Response> {
  const repo = new Repository(env.DB);
  const settings = await repo.getSettings(auth.userId);
  const result = await replanUser(deliveryEnv(env, repo), auth.userId, settings, now);
  await notifyScheduler(env, auth.userId);
  return ok({ replanned: true, batches: result.batches, events: result.events, serverTime: now });
}

export async function handleStatus(env: Env, auth: AuthContext, now: number): Promise<Response> {
  const repo = new Repository(env.DB);
  const [rows, settings, batches, logs] = await Promise.all([
    repo.listActiveSubmarines(auth.userId),
    repo.getSettings(auth.userId),
    repo.listPendingBatches(auth.userId),
    repo.listLogs(auth.userId, 5),
  ]);

  const counts = { total: rows.length, sailing: 0, returned: 0, docked: 0 };
  for (const row of rows) {
    const state = deriveState(row.return_at, now);
    counts[state] += 1;
  }

  const nextDue = batches.reduce<number | null>((min, batch) => {
    const candidates = [batch.advance_notify_at, batch.notify_at].filter((v): v is number => v !== null);
    for (const c of candidates) if (min === null || c < min) min = c;
    return min;
  }, null);

  return ok({
    userId: auth.userId,
    serverTime: now,
    scheduler: { nextAlarmAt: nextDue, pendingBatches: batches.length },
    submarines: counts,
    lastNotification: logs[0]
      ? { eventType: logs[0].event_type, status: logs[0].status, at: logs[0].created_at }
      : null,
    providerConfigured: settings.provider !== 'none' && settings.providerTokenEnc.length > 0,
    notificationEnabled: settings.notificationEnabled,
    settings: mapSettingsSummary(settings),
  });
}

function mapSettingsSummary(settings: ReturnType<typeof mapSettings>) {
  return {
    mergeWindowMinutes: settings.mergeWindowMinutes,
    advanceNotificationMinutes: settings.advanceNotificationMinutes,
    provider: settings.provider,
    timezone: settings.timezone,
  };
}

export async function handleNotifications(env: Env, auth: AuthContext, now: number, limit: number): Promise<Response> {
  const repo = new Repository(env.DB);
  const logs = await repo.listLogs(auth.userId, limit);
  return ok({
    notifications: logs.map((log) => ({
      id: log.id,
      batchId: log.batch_id,
      eventType: log.event_type,
      status: log.status,
      provider: log.provider,
      attempts: log.attempts,
      createdAt: log.created_at,
    })),
    serverTime: now,
  });
}

export async function handleLogs(env: Env, auth: AuthContext, now: number, url: URL): Promise<Response> {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
  const type = url.searchParams.get('type') ?? undefined;
  const repo = new Repository(env.DB);
  const logs = await repo.listLogs(auth.userId, limit, type);
  return ok({
    logs: logs.map((log) => ({
      id: log.id,
      batchId: log.batch_id,
      eventType: log.event_type,
      status: log.status,
      provider: log.provider,
      attempts: log.attempts,
      error: log.error_message,
      createdAt: log.created_at,
    })),
    serverTime: nowSeconds(),
  });
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
