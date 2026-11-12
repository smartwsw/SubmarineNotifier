import type { Env } from '../index.js';
import { Repository } from '../storage/repository.js';
import type { UserSettings } from '../storage/repository.js';
import { parseSettingsPatch, validatePushUrl } from '../utils/validation.js';
import { ApiError, ok, readJson } from '../utils/http.js';
import { encryptSecret } from '../utils/crypto.js';
import { deliveryEnv, replanUser } from '../services/delivery-service.js';
import type { AuthContext } from './auth.js';

export function settingsToJson(settings: UserSettings) {
  return {
    mergeWindowMinutes: settings.mergeWindowMinutes,
    advanceNotificationMinutes: settings.advanceNotificationMinutes,
    notificationEnabled: settings.notificationEnabled,
    provider: settings.provider,
    providerServerUrl: settings.providerServerUrl,
    providerTopic: settings.providerTopic,
    providerConfigured: settings.providerTokenEnc.length > 0,
    providerTokenMasked: settings.providerTokenEnc.length > 0 ? '••••••••' : '',
    notifyTitle: settings.notifyTitle,
    notifyBodyTemplate: settings.notifyBodyTemplate,
    notifyGroup: settings.notifyGroup,
    notifySound: settings.notifySound,
    notifyIcon: settings.notifyIcon,
    notifyPriority: settings.notifyPriority,
    timezone: settings.timezone,
    updatedAt: settings.updatedAt,
  };
}

export async function handleGetSettings(env: Env, auth: AuthContext): Promise<Response> {
  const repo = new Repository(env.DB);
  const settings = await repo.getSettings(auth.userId);
  return ok(settingsToJson(settings));
}

export async function handlePutSettings(request: Request, env: Env, auth: AuthContext, now: number): Promise<Response> {
  const body = await readJson(request);
  const { patch, errors } = parseSettingsPatch(body);
  if (errors.length > 0) throw new ApiError(400, 'VALIDATION_ERROR', errors.map((e) => `${e.field}: ${e.message}`).join('; '));

  // 保存时即校验推送地址：生产环境只允许 https，避免"能保存但永远发不出去"
  if (patch.providerServerUrl) {
    const allowHosts = env.ENVIRONMENT === 'dev' ? (env.DEV_INSECURE_PUSH_HOSTS ?? '').split(',').filter(Boolean) : [];
    const check = validatePushUrl(patch.providerServerUrl, allowHosts, env.ENVIRONMENT);
    if (!check.ok) throw new ApiError(400, 'INVALID_PUSH_URL', `Push server URL rejected: ${check.reason}`);
  }

  const repo = new Repository(env.DB);
  const current = await repo.getSettings(auth.userId);

  const next: UserSettings = {
    ...current,
    mergeWindowMinutes: patch.mergeWindowMinutes ?? current.mergeWindowMinutes,
    advanceNotificationMinutes: patch.advanceNotificationMinutes ?? current.advanceNotificationMinutes,
    notificationEnabled: patch.notificationEnabled ?? current.notificationEnabled,
    provider: patch.provider ?? current.provider,
    providerServerUrl: patch.providerServerUrl ?? current.providerServerUrl,
    providerTopic: patch.providerTopic ?? current.providerTopic,
    notifyTitle: patch.notifyTitle ?? current.notifyTitle,
    notifyBodyTemplate: patch.notifyBodyTemplate ?? current.notifyBodyTemplate,
    notifyGroup: patch.notifyGroup ?? current.notifyGroup,
    notifySound: patch.notifySound ?? current.notifySound,
    notifyIcon: patch.notifyIcon ?? current.notifyIcon,
    notifyPriority: patch.notifyPriority ?? current.notifyPriority,
    timezone: patch.timezone ?? current.timezone,
    updatedAt: now,
  };

  // 凭据只在提供非空值时更新（允许显式清空时传空字符串）
  if (patch.providerToken !== undefined) {
    next.providerTokenEnc = patch.providerToken
      ? await encryptSecret(patch.providerToken, env.SECRETS_KEY, auth.userId)
      : '';
  }

  await repo.saveSettings(auth.userId, next, now);

  const replanTriggers =
    patch.mergeWindowMinutes !== undefined ||
    patch.advanceNotificationMinutes !== undefined ||
    patch.notificationEnabled !== undefined;

  if (replanTriggers) {
    await replanUser(deliveryEnv(env, repo), auth.userId, next, now);
    const id = env.SCHEDULER.idFromName(auth.userId);
    await env.SCHEDULER.get(id).fetch('https://scheduler/replan', { method: 'POST' });
  }

  return ok(settingsToJson(next));
}
