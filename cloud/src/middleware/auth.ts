import type { Env } from '../index.js';
import { Repository } from '../storage/repository.js';
import { sha256Hex, hmacSha256Hex } from '../utils/crypto.js';
import { ApiError } from '../utils/http.js';
import type { AuthContext } from '../routes/auth.js';

export async function extractIpHash(request: Request, secret: string): Promise<string> {
  const ip = request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';
  const hash = await hmacSha256Hex(secret, ip);
  return hash.slice(0, 16);
}

export async function authenticate(request: Request, env: Env, now: number): Promise<AuthContext> {
  const header = request.headers.get('Authorization');
  if (!header) throw new ApiError(401, 'MISSING_TOKEN', 'Authorization header required');
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) throw new ApiError(401, 'MISSING_TOKEN', 'Malformed Authorization header');

  const token = match[1].trim();
  if (!token.startsWith('srk_') || token.length < 20) {
    throw new ApiError(401, 'INVALID_TOKEN', 'Authentication failed');
  }

  const repo = new Repository(env.DB);
  const row = await repo.findTokenByHash(await sha256Hex(token));
  if (!row) throw new ApiError(401, 'INVALID_TOKEN', 'Authentication failed');
  if (row.revoked_at !== null) throw new ApiError(403, 'TOKEN_REVOKED', 'Token has been revoked');
  if (row.expires_at !== null && row.expires_at <= now) throw new ApiError(403, 'TOKEN_EXPIRED', 'Token expired');

  const user = await repo.getUser(row.user_id);
  if (!user || user.status !== 'active') throw new ApiError(403, 'ACCOUNT_DISABLED', 'Account is not active');

  await repo.touchToken(row.id, row.device_id, now);

  return { tokenId: row.id, userId: row.user_id, deviceId: row.device_id, tokenPrefix: row.token_prefix };
}

export function requireUser(auth: AuthContext | null): AuthContext {
  if (!auth) throw new ApiError(401, 'MISSING_TOKEN', 'Authentication required');
  return auth;
}
