import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Repository, mapSettings } from '../src/storage/repository.js';
import { deliveryEnv, processBatch, replanUser, MAX_ATTEMPTS } from '../src/services/delivery-service.js';
import { buildBatches } from '../src/services/notification-service.js';
import { api, configurePush, listBatches, listBatchItemsWithNames, listLogs, register, syncBody, type RegisteredUser } from './helpers.js';

const now = () => Math.floor(Date.now() / 1000);

interface CapturedPush {
  url: string;
  body: any;
}

let captured: CapturedPush[] = [];
let nextResponse: () => Response = () => new Response(JSON.stringify({ code: 200 }), { status: 200 });

const realFetch = globalThis.fetch;

beforeEach(() => {
  captured = [];
  nextResponse = () => new Response(JSON.stringify({ code: 200 }), { status: 200 });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    captured.push({ url, body });
    return nextResponse();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});

/** 通过 API 同步潜艇，并返回生成的 pending 批次 */
async function syncAndGetBatches(user: RegisteredUser, characterId: string, returns: Array<{ slotIndex: number; name: string; returnAt: number }>) {
  const res = await api('/submarines/sync', {
    method: 'POST',
    token: user.token,
    body: JSON.stringify(syncBody(characterId, returns)),
  });
  expect(res.status).toBe(200);
  return listBatches(user.userId);
}

describe('通知投递', () => {
  it('到期批次发送正式通知并标记 sent', async () => {
    const user = await register();
    await configurePush(user.userId, { advanceNotificationMinutes: 0 });
    const t0 = now();
    const [batch] = await syncAndGetBatches(user, '3001', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }]);

    const repo = new Repository(env.DB);
    const settings = await repo.getSettings(user.userId);
    const outcome = await processBatch(deliveryEnv(env, repo), user.userId, batch!, settings, t0 + 601);

    expect(outcome.sent).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe('https://api.day.app/push');
    expect(captured[0]!.body.device_key).toBe('test-device-key');
    expect(captured[0]!.body.title).toContain('潜水艇返航');
    expect(captured[0]!.body.body).toContain('U1');

    const after = await repo.getBatch(batch!.id, user.userId);
    expect(after!.status).toBe('sent');
    expect((await listLogs(user.userId)).filter((l) => l.event_type === 'returned')).toHaveLength(1);
  });

  it('未到期时不发送', async () => {
    const user = await register();
    await configurePush(user.userId);
    const t0 = now();
    const [batch] = await syncAndGetBatches(user, '3002', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }]);

    const repo = new Repository(env.DB);
    const settings = await repo.getSettings(user.userId);
    const outcome = await processBatch(deliveryEnv(env, repo), user.userId, batch!, settings, t0 + 100);

    expect(outcome.sent).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it('提前通知按 notify_at - advance 发送，且只发一次', async () => {
    const user = await register();
    await configurePush(user.userId, { advanceNotificationMinutes: 5 });
    const t0 = now();
    const [batch] = await syncAndGetBatches(user, '3003', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }]);

    expect(batch!.advance_notify_at).toBe(batch!.notify_at - 300);

    const repo = new Repository(env.DB);
    const settings = await repo.getSettings(user.userId);

    // 提前时刻：发送提前通知，但未到正式通知
    const first = await processBatch(deliveryEnv(env, repo), user.userId, batch!, settings, batch!.advance_notify_at!);
    expect(first.advanced).toBe(true);
    expect(first.sent).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.body.title).toContain('即将返航');

    const advanced = await repo.getBatch(batch!.id, user.userId);
    expect(advanced!.advanced_sent_at).not.toBeNull();

    // 重复执行同一时刻：不得重复推送
    const again = await processBatch(deliveryEnv(env, repo), user.userId, advanced!, settings, batch!.advance_notify_at!);
    expect(again.advanced).toBe(false);
    expect(captured).toHaveLength(1);

    // 到正式通知时间：只发返航通知
    const final = await processBatch(deliveryEnv(env, repo), user.userId, advanced!, settings, batch!.notify_at);
    expect(final.sent).toBe(true);
    expect(captured).toHaveLength(2);
    expect(captured[1]!.body.title).toBe('潜水艇返航');
  });

  it('批次重算后不会重复发送提前通知（按 notify_at 去重）', async () => {
    const user = await register();
    await configurePush(user.userId, { advanceNotificationMinutes: 5 });
    const t0 = now();
    const [batch] = await syncAndGetBatches(user, '3004', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }]);

    const repo = new Repository(env.DB);
    const settings = await repo.getSettings(user.userId);
    await processBatch(deliveryEnv(env, repo), user.userId, batch!, settings, batch!.advance_notify_at!);
    expect(captured).toHaveLength(1);

    // 重算：取消旧批次、基于同一潜艇事件重建
    await replanUser(deliveryEnv(env, repo), user.userId, settings, now());
    const [rebuilt] = await listBatches(user.userId);
    expect(rebuilt).toBeDefined();

    const outcome = await processBatch(
      deliveryEnv(env, repo),
      user.userId,
      (await repo.getBatch(rebuilt!.id, user.userId))!,
      settings,
      rebuilt!.advance_notify_at!,
    );

    expect(outcome.advanced).toBe(false);
    expect(captured).toHaveLength(1);
  });

  it('推送关闭时不发送', async () => {
    const user = await register();
    await configurePush(user.userId, { notificationEnabled: false });
    const t0 = now();
    const [batch] = await syncAndGetBatches(user, '3005', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }]);

    const repo = new Repository(env.DB);
    const settings = await repo.getSettings(user.userId);
    const outcome = await processBatch(deliveryEnv(env, repo), user.userId, batch!, settings, t0 + 601);

    expect(outcome.skippedReason).toBe('notifications_disabled');
    expect(captured).toHaveLength(0);
  });

  it('重复处理同一批次不会重复推送（幂等）', async () => {
    const user = await register();
    await configurePush(user.userId);
    const t0 = now();
    const [batch] = await syncAndGetBatches(user, '3006', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }]);

    const repo = new Repository(env.DB);
    const settings = await repo.getSettings(user.userId);
    const fresh = (await repo.getBatch(batch!.id, user.userId))!;

    await processBatch(deliveryEnv(env, repo), user.userId, fresh, settings, t0 + 601);
    await processBatch(deliveryEnv(env, repo), user.userId, fresh, settings, t0 + 602);
    await processBatch(deliveryEnv(env, repo), user.userId, fresh, settings, t0 + 700);

    expect(captured).toHaveLength(1);
    expect((await listLogs(user.userId)).filter((l) => l.event_type === 'returned')).toHaveLength(1);
  });
});

describe('Bark 失败重试', () => {
  it('5xx 失败后按退避安排重试，不标记 sent', async () => {
    const user = await register();
    await configurePush(user.userId);
    const t0 = now();
    const [batch] = await syncAndGetBatches(user, '3101', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }]);

    const repo = new Repository(env.DB);
    const settings = await repo.getSettings(user.userId);
    nextResponse = () => new Response('upstream boom', { status: 500 });

    const outcome = await processBatch(deliveryEnv(env, repo), user.userId, batch!, settings, t0 + 601);
    expect(outcome.sent).toBe(false);
    expect(outcome.retryScheduledAt).toBe(t0 + 601 + 60);

    const after = await repo.getBatch(batch!.id, user.userId);
    expect(after!.status).toBe('pending');
    expect(after!.attempt_count).toBe(1);
    expect(after!.next_retry_at).toBe(t0 + 601 + 60);
    expect(after!.last_error).toContain('500');
    // 失败的日志被删除，以便重试重新插入
    expect((await listLogs(user.userId)).filter((l) => l.event_type === 'returned')).toHaveLength(0);
  });

  it('退避期内不会再次发送', async () => {
    const user = await register();
    await configurePush(user.userId);
    const t0 = now();
    const [batch] = await syncAndGetBatches(user, '3102', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }]);

    const repo = new Repository(env.DB);
    const settings = await repo.getSettings(user.userId);
    nextResponse = () => new Response('boom', { status: 500 });
    await processBatch(deliveryEnv(env, repo), user.userId, batch!, settings, t0 + 601);
    expect(captured).toHaveLength(1);

    const withBackoff = (await repo.getBatch(batch!.id, user.userId))!;
    const early = await processBatch(deliveryEnv(env, repo), user.userId, withBackoff, settings, t0 + 610);
    expect(early.skippedReason).toBe('retry_backoff');
    expect(captured).toHaveLength(1);

    // 退避结束后重试成功
    nextResponse = () => new Response(JSON.stringify({ code: 200 }), { status: 200 });
    const retried = (await repo.getBatch(batch!.id, user.userId))!;
    const outcome = await processBatch(deliveryEnv(env, repo), user.userId, retried, settings, t0 + 661);
    expect(outcome.sent).toBe(true);
    expect(captured).toHaveLength(2);
    expect((await repo.getBatch(batch!.id, user.userId))!.status).toBe('sent');
  });

  it('达到最大重试次数后标记 failed', async () => {
    const user = await register();
    await configurePush(user.userId);
    const t0 = now();
    const [batch] = await syncAndGetBatches(user, '3103', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }]);

    const repo = new Repository(env.DB);
    const settings = await repo.getSettings(user.userId);
    nextResponse = () => new Response('boom', { status: 503 });

    let at = t0 + 601;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const current = (await repo.getBatch(batch!.id, user.userId))!;
      if (current.status !== 'pending') break;
      await processBatch(deliveryEnv(env, repo), user.userId, current, settings, at);
      at += 1000;
    }

    const final = await repo.getBatch(batch!.id, user.userId);
    expect(final!.status).toBe('failed');
    expect(final!.attempt_count).toBe(MAX_ATTEMPTS);
    expect((await listLogs(user.userId)).filter((l) => l.event_type === 'returned' && l.status === 'failed')).toHaveLength(1);
  });

  it('4xx（非 429）不重试，直接 failed', async () => {
    const user = await register();
    await configurePush(user.userId);
    const t0 = now();
    const [batch] = await syncAndGetBatches(user, '3104', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }]);

    const repo = new Repository(env.DB);
    const settings = await repo.getSettings(user.userId);
    nextResponse = () => new Response(JSON.stringify({ code: 400, message: 'bad device key' }), { status: 400 });

    const outcome = await processBatch(deliveryEnv(env, repo), user.userId, batch!, settings, t0 + 601);
    expect(outcome.retryScheduledAt).toBeUndefined();
    expect((await repo.getBatch(batch!.id, user.userId))!.status).toBe('failed');
  });
});

describe('批次重排', () => {
  it('重排不影响已发送批次与已发送事件', async () => {
    const user = await register();
    await configurePush(user.userId);
    const t0 = now();
    await syncAndGetBatches(user, '3201', [
      { slotIndex: 0, name: 'U1', returnAt: t0 + 600 },
      { slotIndex: 1, name: 'U2', returnAt: t0 + 3600 },
    ]);

    const repo = new Repository(env.DB);
    const settings = await repo.getSettings(user.userId);
    const [first] = await listBatches(user.userId);
    await processBatch(deliveryEnv(env, repo), user.userId, first!, settings, t0 + 700);
    const sentCount = captured.length;
    expect(sentCount).toBeGreaterThan(0);

    await replanUser(deliveryEnv(env, repo), user.userId, settings, now());

    const pending = await listBatches(user.userId);
    expect(pending).toHaveLength(1);
    const items = await listBatchItemsWithNames(pending[0]!.id);
    expect(items.map((i) => i.submarine_name)).toEqual(['U2']);

    const sentRow = await repo.getBatch(first!.id, user.userId);
    expect(sentRow!.status).toBe('sent');
  });

  it('重排后批次成员与合并窗口一致', async () => {
    const user = await register();
    await configurePush(user.userId, { mergeWindowMinutes: 10 });
    const t0 = now();
    // 4 艘艇：前两艘相差 9 分钟，第三艘相差 18 分钟，第四艘相差 27 分钟
    await syncAndGetBatches(user, '3202', [
      { slotIndex: 0, name: 'U1', returnAt: t0 + 600 },
      { slotIndex: 1, name: 'U2', returnAt: t0 + 1140 },
      { slotIndex: 2, name: 'U3', returnAt: t0 + 1680 },
      { slotIndex: 3, name: 'U4', returnAt: t0 + 2220 },
    ]);

    const batches = await listBatches(user.userId);
    expect(batches).toHaveLength(2);
    const groups = await Promise.all(batches.map(async (b) => (await listBatchItemsWithNames(b.id)).map((i) => i.submarine_name)));
    expect(groups).toEqual([['U1', 'U2'], ['U3', 'U4']]);
  });

  it('修改合并窗口后按新窗口重排', async () => {
    const user = await register();
    await configurePush(user.userId, { mergeWindowMinutes: 10 });
    const t0 = now();
    await syncAndGetBatches(user, '3203', [
      { slotIndex: 0, name: 'U1', returnAt: t0 + 600 },
      { slotIndex: 1, name: 'U2', returnAt: t0 + 1200 },
    ]);
    expect(await listBatches(user.userId)).toHaveLength(1);

    const updated = await api('/settings', {
      method: 'PUT',
      token: user.token,
      body: JSON.stringify({ mergeWindowMinutes: 5 }),
    });
    expect(updated.status).toBe(200);
    expect(await listBatches(user.userId)).toHaveLength(2);
  });
});

describe('推送配置与测试推送', () => {
  it('设置接口不返回推送凭据明文', async () => {
    const user = await register();
    const res = await api('/settings', {
      method: 'PUT',
      token: user.token,
      body: JSON.stringify({ provider: 'bark', providerToken: 'secret-device-key', providerServerUrl: 'https://api.day.app' }),
    });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('secret-device-key');
    expect(res.body.data.providerConfigured).toBe(true);

    const stored = await env.DB.prepare('SELECT provider_token_enc FROM user_settings WHERE user_id = ?')
      .bind(user.userId)
      .first<{ provider_token_enc: string }>();
    expect(stored!.provider_token_enc).not.toContain('secret-device-key');
    expect(stored!.provider_token_enc.length).toBeGreaterThan(20);
  });

  it('测试推送调用 Bark /push 并返回成功', async () => {
    const user = await register();
    await api('/settings', {
      method: 'PUT',
      token: user.token,
      body: JSON.stringify({ provider: 'bark', providerToken: 'test-device-key', providerServerUrl: 'https://api.day.app' }),
    });

    const res = await api('/push/test', { method: 'POST', token: user.token, body: '{}' });
    expect(res.status).toBe(200);
    expect(res.body.data.delivered).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe('https://api.day.app/push');
    expect(captured[0]!.body.title).toContain('测试');
  });

  it('测试推送失败返回 502 且不泄露凭据', async () => {
    const user = await register();
    await api('/settings', {
      method: 'PUT',
      token: user.token,
      body: JSON.stringify({ provider: 'bark', providerToken: 'test-device-key', providerServerUrl: 'https://api.day.app' }),
    });
    nextResponse = () => new Response('denied', { status: 500 });

    const res = await api('/push/test', { method: 'POST', token: user.token, body: '{}' });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('test-device-key');
  });

  it('未配置推送服务时测试推送返回 400', async () => {
    const user = await register();
    const res = await api('/push/test', { method: 'POST', token: user.token, body: '{}' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('dev 环境允许白名单内 http，生产环境拒绝', async () => {
    const user = await register();
    const allowed = await api('/push/test', {
      method: 'POST',
      token: user.token,
      body: JSON.stringify({ provider: 'bark', deviceKey: 'k', serverUrl: 'http://localhost:8080' }),
    });
    expect(allowed.status).toBe(200);

    const blocked = await api('/push/test', {
      method: 'POST',
      token: user.token,
      body: JSON.stringify({ provider: 'bark', deviceKey: 'k', serverUrl: 'http://evil.example.com' }),
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error?.code).toBe('INVALID_PUSH_URL');
  });

  it('保存设置时也会拒绝非白名单 http 推送地址', async () => {
    const user = await register();

    const allowed = await api('/settings', {
      method: 'PUT',
      token: user.token,
      body: JSON.stringify({ provider: 'bark', providerServerUrl: 'http://localhost:8080' }),
    });
    expect(allowed.status).toBe(200);

    const blocked = await api('/settings', {
      method: 'PUT',
      token: user.token,
      body: JSON.stringify({ provider: 'bark', providerServerUrl: 'http://evil.example.com' }),
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error?.code).toBe('INVALID_PUSH_URL');

    // 拒绝后原值保持不变
    const current = await api('/settings', { token: user.token });
    expect(current.body.data.providerServerUrl).toBe('http://localhost:8080');
  });
});

describe('立即发送下次返航（POST /push/next）', () => {
  it('按真实批次内容即时推送', async () => {
    const user = await register();
    await configurePush(user.userId, { advanceNotificationMinutes: 0 });
    const t0 = now();
    const returns = [
      { slotIndex: 0, name: 'U1', returnAt: t0 + 600 },
      { slotIndex: 1, name: 'U2', returnAt: t0 + 660 },
    ];
    await syncAndGetBatches(user, '3401', returns);

    const res = await api('/push/next', { method: 'POST', token: user.token, body: '{}' });

    expect(res.status).toBe(200);
    expect(res.body.data.delivered).toBe(true);
    expect(res.body.data.kind).toBe('returned');
    expect(res.body.data.shipCount).toBe(2);
    expect(res.body.data.returnAt).toBe(t0 + 660);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe('https://api.day.app/push');
    expect(captured[0]!.body.title).toContain('潜水艇返航');
    expect(captured[0]!.body.body).toContain('U1');
    expect(captured[0]!.body.body).toContain('U2');
  });

  it('不影响真实排程：批次仍是 pending，事件键未写入，正式通知照常发送', async () => {
    const user = await register();
    await configurePush(user.userId, { advanceNotificationMinutes: 0 });
    const t0 = now();
    const [batch] = await syncAndGetBatches(user, '3402', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }]);

    await api('/push/next', { method: 'POST', token: user.token, body: '{}' });
    expect(captured).toHaveLength(1);

    const stillPending = (await listBatches(user.userId)).find((b) => b.id === batch!.id);
    expect(stillPending!.status).toBe('pending');
    expect(stillPending!.attempt_count).toBe(0);
    expect(stillPending!.next_retry_at).toBeNull();

    const retLogs = (await listLogs(user.userId)).filter((l) => l.event_type === 'returned');
    expect(retLogs).toHaveLength(0);
    // 只留下一条 next 类型的审计日志，其键不占用 ret: 命名空间
    const nextLogs = (await listLogs(user.userId)).filter((l) => l.event_type === 'next');
    expect(nextLogs).toHaveLength(1);
    expect(nextLogs[0]!.event_key.startsWith('next:')).toBe(true);

    // 到点后正式通知仍然发送
    const repo = new Repository(env.DB);
    const settings = await repo.getSettings(user.userId);
    const outcome = await processBatch(deliveryEnv(env, repo), user.userId, stillPending!, settings, t0 + 601);
    expect(outcome.sent).toBe(true);
    expect(captured).toHaveLength(2);
  });

  it('提前通知尚未发出时按「即将返航」渲染', async () => {
    const user = await register();
    await configurePush(user.userId, { advanceNotificationMinutes: 5 });
    const t0 = now();
    await syncAndGetBatches(user, '3403', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }]);

    const res = await api('/push/next', { method: 'POST', token: user.token, body: '{}' });

    expect(res.status).toBe(200);
    expect(res.body.data.kind).toBe('advance');
    expect(res.body.data.notifyAt).toBe(t0 + 600);
    expect(captured[0]!.body.title).toContain('即将返航');
  });

  it('没有待发批次时返回 409', async () => {
    const user = await register();
    await configurePush(user.userId);

    const res = await api('/push/next', { method: 'POST', token: user.token, body: '{}' });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('NO_UPCOMING_RETURN');
    expect(captured).toHaveLength(0);
  });

  it('关闭通知或未配置推送时拒绝发送', async () => {
    const disabled = await register();
    await configurePush(disabled.userId, { notificationEnabled: false });
    await api('/submarines/sync', {
      method: 'POST',
      token: disabled.token,
      body: JSON.stringify(syncBody('3405', [{ slotIndex: 0, returnAt: now() + 600 }])),
    });
    const disabledRes = await api('/push/next', { method: 'POST', token: disabled.token, body: '{}' });
    expect(disabledRes.status).toBe(400);
    expect(disabledRes.body.error?.code).toBe('NOTIFICATIONS_DISABLED');

    const unconfigured = await register();
    await api('/submarines/sync', {
      method: 'POST',
      token: unconfigured.token,
      body: JSON.stringify(syncBody('3406', [{ slotIndex: 0, returnAt: now() + 600 }])),
    });
    const noneRes = await api('/push/next', { method: 'POST', token: unconfigured.token, body: '{}' });
    expect(noneRes.status).toBe(400);
    expect(noneRes.body.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(captured).toHaveLength(0);
  });

  it('发送失败返回 502 且不泄露凭据', async () => {
    const user = await register();
    await configurePush(user.userId);
    await syncAndGetBatches(user, '3407', [{ slotIndex: 0, name: 'U1', returnAt: now() + 600 }]);
    nextResponse = () => new Response('denied', { status: 500 });

    const res = await api('/push/next', { method: 'POST', token: user.token, body: '{}' });

    expect(res.status).toBe(502);
    expect(res.body.error?.code).toBe('PUSH_FAILED');
    expect(JSON.stringify(res.body)).not.toContain('test-device-key');
    const logs = (await listLogs(user.userId)).filter((l) => l.event_type === 'next');
    expect(logs[0]!.status).toBe('failed');
  });

  it('跳过多艘都已返航后残留的空批次', async () => {
    const user = await register();
    await configurePush(user.userId, { advanceNotificationMinutes: 0 });
    const t0 = now();
    await syncAndGetBatches(user, '3408', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }]);
    // 模拟批次成员已被删除、批次本身还没被 alarm 清理
    const [batch] = await listBatches(user.userId);
    await env.DB.prepare('DELETE FROM notification_batch_items WHERE batch_id = ?').bind(batch!.id).run();

    const res = await api('/push/next', { method: 'POST', token: user.token, body: '{}' });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('NO_UPCOMING_RETURN');
  });
});

describe('批次构建与数据库一致性', () => {
  it('发送后事件键记录在 notification_logs，重排不会重建同一事件', async () => {
    const user = await register();
    await configurePush(user.userId);
    const t0 = now();
    const [batch] = await syncAndGetBatches(user, '3301', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }]);

    const repo = new Repository(env.DB);
    const settings = await repo.getSettings(user.userId);
    await processBatch(deliveryEnv(env, repo), user.userId, batch!, settings, t0 + 601);

    const logs = await listLogs(user.userId);
    expect(logs[0]!.event_key).toMatch(/^ret:sub_[^:]+:\d+$/);

    await replanUser(deliveryEnv(env, repo), user.userId, settings, now());
    expect(await listBatches(user.userId)).toHaveLength(0);
  });

  it('buildBatches 输出可直接持久化的批次结构', () => {
    const batches = buildBatches(
      [
        { submarineId: 'a', returnAt: 100 },
        { submarineId: 'b', returnAt: 200 },
      ],
      100,
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]!.anchorReturnAt).toBe(100);
    expect(batches[0]!.latestReturnAt).toBe(200);
    expect(batches[0]!.notifyAt).toBe(200);
  });

  it('mapSettings 为无记录用户返回默认配置', async () => {
    const settings = mapSettings(null);
    expect(settings.mergeWindowMinutes).toBe(10);
    expect(settings.provider).toBe('bark');
    expect(settings.notificationEnabled).toBe(true);
  });
});
