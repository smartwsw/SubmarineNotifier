import type { Env } from '../index.js';
import { Repository } from '../storage/repository.js';
import { generateToken, sha256Hex, tokenPrefix } from '../utils/crypto.js';
import { ApiError, ok, readJson } from '../utils/http.js';
import { checkRateLimit } from './rate-limit.js';
import { extractIpHash } from '../middleware/auth.js';
import { isRecord } from '../utils/validation.js';

export interface AuthContext {
  tokenId: string;
  userId: string;
  deviceId: string | null;
  tokenPrefix: string;
}

export async function handleRegister(request: Request, env: Env, now: number, ipHash: string): Promise<Response> {
  await checkRateLimit(env, `reg:${ipHash}`, 5, 3600, now);
  const body = await readJson(request);
  const deviceName = isRecord(body) && typeof body.deviceName === 'string' ? body.deviceName.trim().slice(0, 64) : '';

  const repo = new Repository(env.DB);
  const userId = await repo.createUser(now);
  const deviceId = await repo.createDevice(userId, deviceName || '默认设备', now);
  const token = generateToken();
  await repo.createToken({
    userId,
    deviceId,
    tokenHash: await sha256Hex(token),
    tokenPrefix: tokenPrefix(token),
    now,
    expiresAt: null,
  });

  return ok({ userId, token, tokenPrefix: tokenPrefix(token), deviceId, serverTime: now }, 201);
}

export async function handleCreateDevice(request: Request, env: Env, auth: AuthContext, now: number): Promise<Response> {
  const body = await readJson(request);
  const deviceName = isRecord(body) && typeof body.deviceName === 'string' ? body.deviceName.trim().slice(0, 64) : '';
  const repo = new Repository(env.DB);

  const deviceId = await repo.createDevice(auth.userId, deviceName || '新设备', now);
  const token = generateToken();
  await repo.createToken({
    userId: auth.userId,
    deviceId,
    tokenHash: await sha256Hex(token),
    tokenPrefix: tokenPrefix(token),
    now,
    expiresAt: null,
  });

  return ok({ deviceId, token, tokenPrefix: tokenPrefix(token), serverTime: now }, 201);
}

export async function handleWhoAmI(env: Env, auth: AuthContext, now: number): Promise<Response> {
  const repo = new Repository(env.DB);
  const devices = await repo.listDevices(auth.userId);
  return ok({
    userId: auth.userId,
    tokenPrefix: auth.tokenPrefix,
    deviceId: auth.deviceId,
    devices: devices.map((d) => ({
      id: d.id,
      name: d.device_name,
      status: d.status,
      lastSeenAt: d.last_seen_at,
      createdAt: d.created_at,
    })),
    serverTime: now,
  });
}

export async function handleRotate(request: Request, env: Env, auth: AuthContext, now: number): Promise<Response> {
  const repo = new Repository(env.DB);
  const body = await readJson(request);
  const keepDevice = !isRecord(body) || body.keepDevice !== false;

  const token = generateToken();
  await repo.createToken({
    userId: auth.userId,
    deviceId: keepDevice ? auth.deviceId : null,
    tokenHash: await sha256Hex(token),
    tokenPrefix: tokenPrefix(token),
    now,
    expiresAt: null,
    rotatedFrom: auth.tokenId,
  });
  await repo.revokeToken(auth.tokenId, now);

  return ok({ token, tokenPrefix: tokenPrefix(token), serverTime: now });
}

export async function handleRevoke(request: Request, env: Env, auth: AuthContext, now: number): Promise<Response> {
  const body = await readJson(request);
  const allDevices = isRecord(body) && body.allDevices === true;
  const repo = new Repository(env.DB);

  if (allDevices) {
    for (const device of await repo.listDevices(auth.userId)) {
      await repo.revokeDevice(auth.userId, device.id, now);
    }
  }
  await repo.revokeToken(auth.tokenId, now);
  return ok({ revoked: true });
}

export async function handleListDevices(env: Env, auth: AuthContext): Promise<Response> {
  const repo = new Repository(env.DB);
  const devices = await repo.listDevices(auth.userId);
  return ok({
    devices: devices.map((d) => ({
      id: d.id,
      name: d.device_name,
      status: d.status,
      lastSeenAt: d.last_seen_at,
      createdAt: d.created_at,
    })),
  });
}

export async function handleDeleteDevice(env: Env, auth: AuthContext, deviceId: string, now: number): Promise<Response> {
  const repo = new Repository(env.DB);
  const okDeleted = await repo.revokeDevice(auth.userId, deviceId, now);
  if (!okDeleted) throw new ApiError(404, 'NOT_FOUND', 'Device not found');
  return ok({ deleted: true });
}

export async function handleDeleteAccount(request: Request, env: Env, auth: AuthContext, now: number): Promise<Response> {
  const body = await readJson(request);
  if (!isRecord(body) || body.confirm !== 'DELETE') {
    throw new ApiError(400, 'CONFIRMATION_REQUIRED', 'Body must contain {"confirm":"DELETE"}');
  }
  const repo = new Repository(env.DB);
  await repo.deleteUser(auth.userId);

  const id = env.SCHEDULER.idFromName(auth.userId);
  const stub = env.SCHEDULER.get(id);
  await stub.fetch('https://scheduler/delete', { method: 'POST' });

  return new Response(null, { status: 204 });
}

export { extractIpHash };
