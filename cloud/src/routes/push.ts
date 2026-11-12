import type { Env } from '../index.js';
import { Repository } from '../storage/repository.js';
import { buildNoticeLines, resolvePushTarget, sanitizePushTarget, deliveryEnv } from '../services/delivery-service.js';
import { formatNotification } from '../services/notification-service.js';
import { dispatch, getProvider } from '../services/push/index.js';
import { formatInTimeZone } from '../utils/time.js';
import { ApiError, ok, readJson } from '../utils/http.js';
import { checkRateLimit } from './rate-limit.js';
import type { AuthContext } from './auth.js';
import { isRecord, validatePushUrl } from '../utils/validation.js';

export async function handleTestPush(request: Request, env: Env, auth: AuthContext, now: number): Promise<Response> {
  await checkRateLimit(env, `test:${auth.userId}`, 10, 60, now);
  const body = await readJson(request);
  const repo = new Repository(env.DB);
  const settings = await repo.getSettings(auth.userId);

  const override = isRecord(body)
    ? {
        provider: typeof body.provider === 'string' ? body.provider : undefined,
        serverUrl: typeof body.serverUrl === 'string' ? body.serverUrl.trim() : undefined,
        token: typeof body.deviceKey === 'string' ? body.deviceKey.trim() : typeof body.token === 'string' ? body.token.trim() : undefined,
        topic: typeof body.topic === 'string' ? body.topic.trim() : undefined,
      }
    : {};

  const target = await resolvePushTarget(settings, env.SECRETS_KEY, auth.userId, override);
  if (!target || target.provider === 'none') {
    throw new ApiError(400, 'PROVIDER_NOT_CONFIGURED', 'No push provider configured');
  }

  const serverUrl = target.serverUrl || (target.provider === 'ntfy' ? 'https://ntfy.sh' : 'https://api.day.app');
  const allowHosts = env.ENVIRONMENT === 'dev' ? (env.DEV_INSECURE_PUSH_HOSTS ?? '').split(',').filter(Boolean) : [];
  const urlCheck = validatePushUrl(serverUrl, allowHosts, env.ENVIRONMENT);
  if (!urlCheck.ok) {
    throw new ApiError(400, 'INVALID_PUSH_URL', `Push server URL rejected: ${urlCheck.reason}`);
  }
  target.serverUrl = urlCheck.url ? urlCheck.url.toString().replace(/\/+$/, '') : serverUrl;

  const provider = getProvider(target.provider);
  if (!provider) throw new ApiError(400, 'PROVIDER_NOT_SUPPORTED', 'Unsupported provider');
  const validation = provider.validateConfiguration(target);
  if (!validation.valid) throw new ApiError(400, 'PROVIDER_NOT_CONFIGURED', `Configuration invalid: ${validation.reason}`);

  let result: Awaited<ReturnType<typeof provider.testNotification>>;
  try {
    result = await provider.testNotification(target);
  } catch (error) {
    result = { delivered: false, provider: target.provider, latencyMs: 0, error: (error as Error).message.slice(0, 200) };
  }

  await repo.tryInsertLog({
    userId: auth.userId,
    batchId: null,
    eventType: 'test',
    eventKey: `test:${auth.userId}:${now}:${crypto.randomUUID()}`,
    status: result.delivered ? 'sent' : 'failed',
    provider: target.provider,
    now,
  });

  if (!result.delivered) {
    throw new ApiError(502, 'PUSH_FAILED', result.error ?? 'Push failed');
  }

  return ok({ delivered: true, provider: result.provider, latencyMs: result.latencyMs });
}

/**
 * 立即发送「下一次返航」的通知（调试/预览用）。
 *
 * 与 /push/test 的区别：内容来自真实的待发批次，按正常投递同样的模板渲染，
 * 所以用户能确认实际会收到什么。
 *
 * 不改动任何排程状态：不写 `ret:`/`adv:` 幂等键，不改批次状态、不推进重试，
 * 因此真实通知仍会按原计划再发一次。
 */
export async function handleNextPush(env: Env, auth: AuthContext, now: number): Promise<Response> {
  await checkRateLimit(env, `next:${auth.userId}`, 10, 60, now);
  const repo = new Repository(env.DB);
  const settings = await repo.getSettings(auth.userId);

  if (!settings.notificationEnabled) {
    throw new ApiError(400, 'NOTIFICATIONS_DISABLED', 'Notifications are disabled');
  }
  if (settings.provider === 'none') {
    throw new ApiError(400, 'PROVIDER_NOT_CONFIGURED', 'No push provider configured');
  }

  // 跳过空批次：它们只是还没被 alarm 清理掉的残留，不能当作"下次返航"
  const pending = await repo.listPendingBatches(auth.userId);
  let batch: (typeof pending)[number] | null = null;
  let items: Awaited<ReturnType<typeof repo.listBatchItems>> = [];
  for (const candidate of pending) {
    const candidateItems = await repo.listBatchItems(candidate.id);
    if (candidateItems.length > 0) {
      batch = candidate;
      items = candidateItems;
      break;
    }
  }
  if (!batch) {
    throw new ApiError(409, 'NO_UPCOMING_RETURN', 'No pending return batch; upload submarine data first');
  }

  const submarines = await repo.listActiveSubmarines(auth.userId);
  const lines = buildNoticeLines(items, submarines);
  // 提前通知还没发时，用户下一次实际收到的就是它
  const kind = batch.advance_notify_at !== null && batch.advanced_sent_at === null ? 'advance' : 'returned';
  const text = formatNotification(
    { title: settings.notifyTitle, bodyTemplate: settings.notifyBodyTemplate },
    lines,
    kind,
    settings.timezone,
    formatInTimeZone,
  );

  const resolved = await resolvePushTarget(settings, env.SECRETS_KEY, auth.userId);
  if (!resolved) throw new ApiError(400, 'PROVIDER_NOT_CONFIGURED', 'No push provider configured');
  const sanitized = sanitizePushTarget(deliveryEnv(env, repo), resolved);
  if (!sanitized.ok) throw new ApiError(400, 'INVALID_PUSH_URL', `Push server URL rejected: ${sanitized.reason}`);
  const target = sanitized.target;

  const provider = getProvider(target.provider);
  if (!provider) throw new ApiError(400, 'PROVIDER_NOT_SUPPORTED', 'Unsupported provider');
  const validation = provider.validateConfiguration(target);
  if (!validation.valid) throw new ApiError(400, 'PROVIDER_NOT_CONFIGURED', `Configuration invalid: ${validation.reason}`);

  const delivered = await dispatch(target.provider, {
    ...text,
    group: settings.notifyGroup,
    sound: settings.notifySound,
    icon: settings.notifyIcon,
    priority: settings.notifyPriority,
    topic: target.topic,
  }, target);

  await repo.tryInsertLog({
    userId: auth.userId,
    batchId: batch.id,
    eventType: 'next',
    eventKey: `next:${auth.userId}:${now}:${crypto.randomUUID()}`,
    status: delivered.result.delivered ? 'sent' : 'failed',
    provider: target.provider,
    now,
  });

  if (!delivered.result.delivered) {
    throw new ApiError(502, 'PUSH_FAILED', delivered.result.error ?? 'Push failed');
  }

  return ok({
    delivered: true,
    provider: delivered.result.provider,
    latencyMs: delivered.result.latencyMs,
    kind,
    notifyAt: batch.notify_at,
    returnAt: batch.latest_return_at,
    shipCount: lines.length,
    title: text.title,
  });
}
