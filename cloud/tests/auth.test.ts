import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, register } from './helpers.js';

describe('注册与 Token 认证', () => {
  it('注册返回 userId 与一次性 token，并以哈希存储', async () => {
    const { status, body } = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ deviceName: 'PC' }),
    });

    expect(status).toBe(201);
    expect(body.data.token).toMatch(/^srk_[A-Za-z0-9_-]{20,}$/);
    expect(body.data.tokenPrefix).toBe(body.data.token.slice(0, 12));

    const row = await env.DB.prepare('SELECT token_hash, token_prefix FROM api_tokens WHERE user_id = ?')
      .bind(body.data.userId)
      .first<{ token_hash: string; token_prefix: string }>();
    expect(row).not.toBeNull();
    expect(row!.token_hash).not.toContain(body.data.token);
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('whoami 返回当前用户与设备', async () => {
    const user = await register('设备A');
    const { status, body } = await api('/auth/whoami', { token: user.token });

    expect(status).toBe(200);
    expect(body.data.userId).toBe(user.userId);
    expect(body.data.devices).toHaveLength(1);
    expect(body.data.devices[0].name).toBe('设备A');
    expect(JSON.stringify(body)).not.toContain(user.token);
  });

  it('缺少或无效 token 返回 401', async () => {
    expect((await api('/auth/whoami')).status).toBe(401);
    expect((await api('/auth/whoami', { token: 'srk_invalidtokenvalue1234567890' })).status).toBe(401);
    expect((await api('/auth/whoami', { token: 'not-a-token' })).status).toBe(401);
  });

  it('轮换后旧 token 立即失效，新 token 可用', async () => {
    const user = await register();
    const rotated = await api('/auth/rotate', { method: 'POST', token: user.token, body: '{}' });
    expect(rotated.status).toBe(200);
    const newToken = rotated.body.data.token as string;
    expect(newToken).not.toBe(user.token);

    expect((await api('/auth/whoami', { token: user.token })).status).toBe(403);
    expect((await api('/auth/whoami', { token: newToken })).status).toBe(200);
  });

  it('吊销设备后该设备的 token 失效', async () => {
    const user = await register();
    const created = await api('/auth/device', {
      method: 'POST',
      token: user.token,
      body: JSON.stringify({ deviceName: '第二台' }),
    });
    const secondToken = created.body.data.token as string;
    expect((await api('/auth/whoami', { token: secondToken })).status).toBe(200);

    const deleted = await api(`/auth/devices/${created.body.data.deviceId}`, { method: 'DELETE', token: user.token });
    expect(deleted.status).toBe(200);

    expect((await api('/auth/whoami', { token: secondToken })).status).toBe(403);
    // 第一个设备的 token 不受影响
    expect((await api('/auth/whoami', { token: user.token })).status).toBe(200);
  });

  it('用户隔离：A 的 token 看不到 B 的设备与潜艇', async () => {
    const alice = await register('Alice');
    const bob = await register('Bob');

    const aliceStatus = await api('/auth/whoami', { token: alice.token });
    const bobStatus = await api('/auth/whoami', { token: bob.token });

    expect(aliceStatus.body.data.userId).not.toBe(bobStatus.body.data.userId);
    expect(aliceStatus.body.data.devices.map((d: { id: string }) => d.id)).not.toContain(bob.deviceId);

    await api('/submarines/sync', {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify({
        characterId: '1001',
        characterName: 'Alice Char',
        worldId: 1,
        collectedAt: 0,
        clientTimeOffsetMs: 0,
        submarines: [{ slotIndex: 0, name: 'A1', rank: 90, returnAt: 0, routePoints: [], parts: {}, state: 'docked' }],
      }),
    });

    const bobList = await api('/submarines', { token: bob.token });
    expect(bobList.body.data.submarines).toHaveLength(0);

    const aliceList = await api('/submarines', { token: alice.token });
    expect(aliceList.body.data.submarines).toHaveLength(1);
  });

  it('删除账号需要确认，且删除后 token 失效', async () => {
    const user = await register();

    const noConfirm = await api('/account', { method: 'DELETE', token: user.token, body: '{}' });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error?.code).toBe('CONFIRMATION_REQUIRED');

    const deleted = await api('/account', {
      method: 'DELETE',
      token: user.token,
      body: JSON.stringify({ confirm: 'DELETE' }),
    });
    expect(deleted.status).toBe(204);

    expect((await api('/auth/whoami', { token: user.token })).status).toBe(401);
    const orphans = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?')
      .bind(user.userId)
      .first<{ n: number }>();
    expect(orphans!.n).toBe(0);
  });
});
