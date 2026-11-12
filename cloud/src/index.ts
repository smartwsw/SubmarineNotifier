import { Repository } from './storage/repository.js';
import { ApiError, CORS_HEADERS, fail, newRequestId, readJson } from './utils/http.js';
import { ValidationError } from './utils/validation.js';
import { authenticate, extractIpHash } from './middleware/auth.js';
import type { AuthContext } from './routes/auth.js';
import {
  handleCreateDevice,
  handleDeleteAccount,
  handleDeleteDevice,
  handleListDevices,
  handleRegister,
  handleRevoke,
  handleRotate,
  handleWhoAmI,
} from './routes/auth.js';
import {
  handleList,
  handleLogs,
  handleNotifications,
  handleRefresh,
  handleRemove,
  handleStatus,
  handleSync,
} from './routes/submarine.js';
import { handleGetSettings, handlePutSettings } from './routes/settings.js';
import { handleNextPush, handleTestPush } from './routes/push.js';
import { SchedulerDurableObject } from './durable-objects/scheduler.js';
import { nowSeconds } from './utils/time.js';

export { SchedulerDurableObject };

export interface Env {
  DB: D1Database;
  SCHEDULER: DurableObjectNamespace;
  SECRETS_KEY: string;
  ENVIRONMENT: string;
  DEV_INSECURE_PUSH_HOSTS?: string;
}

const API_VERSION = 'v1';

function routePath(url: URL): string {
  const prefix = `/api/${API_VERSION}`;
  return url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || '/' : url.pathname;
}

async function initScheduler(env: Env, userId: string): Promise<void> {
  const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName(userId));
  await stub.fetch('https://scheduler/init', { method: 'POST', headers: { 'X-User-Id': userId } });
}

/**
 * 校验关键配置，避免缺失 SECRETS_KEY 时静默产生不可解密的凭据。
 * 返回错误响应，或 null 表示配置正常。
 */
function checkConfiguration(env: Env, requestId: string): Response | null {
  if (!env.SECRETS_KEY) {
    return fail(500, 'MISCONFIGURED', 'SECRETS_KEY is not configured (use `wrangler secret put SECRETS_KEY`)', requestId);
  }
  try {
    if (atob(env.SECRETS_KEY).length !== 32) {
      return fail(500, 'MISCONFIGURED', 'SECRETS_KEY must be 32 bytes encoded as base64', requestId);
    }
  } catch {
    return fail(500, 'MISCONFIGURED', 'SECRETS_KEY must be base64 encoded', requestId);
  }
  return null;
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const requestId = newRequestId();
  const url = new URL(request.url);
  const path = routePath(url);
  const method = request.method.toUpperCase();
  const now = nowSeconds();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const configError = checkConfiguration(env, requestId);
    if (configError) return configError;

    // ---------- 无需认证 ----------
    if (method === 'POST' && path === '/auth/register') {
      const ipHash = await extractIpHash(request, env.SECRETS_KEY);
      return await handleRegister(request, env, now, ipHash);
    }
    if (method === 'GET' && path === '/health') {
      return Response.json({ ok: true, data: { status: 'ok', serverTime: now } });
    }

    // ---------- 认证 ----------
    const auth: AuthContext = await authenticate(request, env, now);
    await initScheduler(env, auth.userId);

    if (method === 'POST' && path === '/auth/device') return await handleCreateDevice(request, env, auth, now);
    if (method === 'GET' && path === '/auth/whoami') return await handleWhoAmI(env, auth, now);
    if (method === 'POST' && path === '/auth/rotate') return await handleRotate(request, env, auth, now);
    if (method === 'POST' && path === '/auth/revoke') return await handleRevoke(request, env, auth, now);
    if (method === 'GET' && path === '/auth/devices') return await handleListDevices(env, auth);

    const deviceMatch = /^\/auth\/devices\/([A-Za-z0-9_-]+)$/.exec(path);
    if (deviceMatch && method === 'DELETE') return await handleDeleteDevice(env, auth, deviceMatch[1]!, now);

    if (method === 'POST' && path === '/submarines/sync') return await handleSync(request, env, auth, now);
    if (method === 'GET' && path === '/submarines') return await handleList(env, auth, now);
    if (method === 'POST' && path === '/submarines/remove') return await handleRemove(request, env, auth, now);
    if (method === 'POST' && path === '/submarines/refresh') return await handleRefresh(env, auth, now);

    if (method === 'GET' && path === '/settings') return await handleGetSettings(env, auth);
    if (method === 'PUT' && path === '/settings') return await handlePutSettings(request, env, auth, now);

    if (method === 'POST' && path === '/bark/test') return await handleTestPush(request, env, auth, now);
    if (method === 'POST' && path === '/push/test') return await handleTestPush(request, env, auth, now);
    if (method === 'POST' && path === '/push/next') return await handleNextPush(env, auth, now);

    if (method === 'GET' && path === '/status') return await handleStatus(env, auth, now);
    if (method === 'GET' && path === '/notifications') {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20));
      return await handleNotifications(env, auth, now, limit);
    }
    if (method === 'GET' && path === '/logs') return await handleLogs(env, auth, now, url);

    if (method === 'DELETE' && path === '/account') return await handleDeleteAccount(request, env, auth, now);

    throw new ApiError(404, 'NOT_FOUND', `No route for ${method} ${path}`);
  } catch (error) {
    if (error instanceof ValidationError) {
      const message = error.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
      return fail(400, 'VALIDATION_ERROR', message, requestId);
    }
    if (error instanceof ApiError) {
      return fail(error.status, error.code, error.message, requestId, error.headers);
    }
    console.error(JSON.stringify({ requestId, path, message: (error as Error).message }));
    return fail(500, 'INTERNAL_ERROR', 'Internal server error', requestId);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;

/** 供测试使用的导出 */
export { handleRequest, Repository };
