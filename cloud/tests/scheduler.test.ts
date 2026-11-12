import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, configurePush, register, syncBody } from './helpers.js';

const now = () => Math.floor(Date.now() / 1000);

let captured: any[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  captured = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ code: 200 }), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});

async function schedulerStub(userId: string) {
  return env.SCHEDULER.get(env.SCHEDULER.idFromName(userId));
}

describe('Scheduler Durable Object', () => {
  it('同步后被初始化，并带有下一次 alarm', async () => {
    const user = await register();
    const t0 = now();
    await syncBodyTo(user, '4001', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }]);

    const stub = await schedulerStub(user.userId);
    const status = await (await stub.fetch('https://scheduler/status', { method: 'POST' })).json<any>();

    expect(status.initialized).toBe(true);
    expect(status.pendingBatches).toBe(1);
    expect(status.nextAlarmAt).toBeGreaterThan(now());
  });

  it('无待处理批次时清除 alarm', async () => {
    const user = await register();
    const stub = await schedulerStub(user.userId);
    // 访问任意鉴权接口会初始化 DO
    await api('/status', { token: user.token });

    await stub.fetch('https://scheduler/replan', { method: 'POST' });
    const status = await (await stub.fetch('https://scheduler/status', { method: 'POST' })).json<any>();
    expect(status.pendingBatches).toBe(0);
    expect(status.nextAlarmAt).toBeNull();
  });

  it('alarm 触发到期批次推送，并重新安排下一次', async () => {
    const user = await register();
    await configurePush(user.userId, { advanceNotificationMinutes: 0 });
    // 返航时间设为过去 30 秒，同步后立即到期（validateReturnAt 允许 7 天内）
    const t0 = now();
    await syncBodyTo(user, '4002', [{ slotIndex: 0, name: 'Due', returnAt: t0 - 30 }]);

    const stub = await schedulerStub(user.userId);
    // alarm 被安排在 now+1 秒；慢机器上它可能先于手动触发自行执行。
    // 两种时序都合法，但结果是确定的：只推送一次，并清空批次。
    const ran = await runDurableObjectAlarm(stub);
    expect(captured.length).toBe(1);
    expect(captured[0]!.body.body).toContain('Due');

    const status = await (await stub.fetch('https://scheduler/status', { method: 'POST' })).json<any>();
    expect(status.pendingBatches).toBe(0);
    expect(status.nextAlarmAt).toBeNull();
    if (ran) expect(status.state.lastRunResult).toContain('sent');

    // 再次触发不得重复推送
    await runDurableObjectAlarm(stub);
    expect(captured.length).toBe(1);
  });

  it('alarm 在没有到期批次时不发送', async () => {
    const user = await register();
    await configurePush(user.userId);
    await syncBodyTo(user, '4003', [{ slotIndex: 0, name: 'Future', returnAt: now() + 3600 }]);

    const stub = await schedulerStub(user.userId);
    // 到期前手动触发 alarm：不应发送
    // runDurableObjectAlarm 会立即运行 alarm（即使尚未到期），这正好模拟提前唤醒
    await runDurableObjectAlarm(stub);
    expect(captured).toHaveLength(0);

    const status = await (await stub.fetch('https://scheduler/status', { method: 'POST' })).json<any>();
    expect(status.pendingBatches).toBe(1);
    expect(status.nextAlarmAt).toBeGreaterThan(now());
  });

  it('删除账号会清理 DO 状态', async () => {
    const user = await register();
    await syncBodyTo(user, '4004', [{ slotIndex: 0, name: 'U1', returnAt: now() + 600 }]);
    const stub = await schedulerStub(user.userId);
    expect((await (await stub.fetch('https://scheduler/status', { method: 'POST' })).json<any>()).initialized).toBe(true);

    const res = await api('/account', {
      method: 'DELETE',
      token: user.token,
      body: JSON.stringify({ confirm: 'DELETE' }),
    });
    expect(res.status).toBe(204);

    const status = await (await stub.fetch('https://scheduler/status', { method: 'POST' })).json<any>();
    expect(status.initialized).toBe(false);
  });

  it('DO 拒绝对已绑定其他用户名的实例重新初始化', async () => {
    const user = await register();
    const stub = await schedulerStub(user.userId);
    await stub.fetch('https://scheduler/init', { method: 'POST', headers: { 'X-User-Id': user.userId } });

    const conflict = await stub.fetch('https://scheduler/init', {
      method: 'POST',
      headers: { 'X-User-Id': 'usr_someoneelse' },
    });
    expect(conflict.status).toBe(409);
  });
});

async function syncBodyTo(
  user: { token: string },
  characterId: string,
  submarines: Array<{ slotIndex: number; name: string; returnAt: number }>,
) {
  const res = await api('/submarines/sync', {
    method: 'POST',
    token: user.token,
    body: JSON.stringify(syncBody(characterId, submarines)),
  });
  expect(res.status).toBe(200);
  return res.body;
}
