import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, listBatches, listBatchItemsWithNames, register, syncBody } from './helpers.js';

const now = () => Math.floor(Date.now() / 1000);

describe('潜水艇同步', () => {
  it('首次同步写入潜艇并生成批次', async () => {
    const user = await register();
    const t0 = now();
    const { status, body } = await api('/submarines/sync', {
      method: 'POST',
      token: user.token,
      body: JSON.stringify(
        syncBody('2001', [
          { slotIndex: 0, name: 'U1', returnAt: t0 + 600 },
          { slotIndex: 1, name: 'U2', returnAt: t0 + 1200 },
        ]),
      ),
    });

    expect(status).toBe(200);
    expect(body.data.accepted).toBe(2);
    expect(body.data.changed).toBe(2);
    expect(body.data.deduped).toBe(false);
    expect(body.data.serverTime).toBeGreaterThan(0);

    const list = await api('/submarines', { token: user.token });
    expect(list.body.data.submarines).toHaveLength(2);
    expect(list.body.data.submarines[0].state).toBe('sailing');

    // t0+600 与 t0+1200 相差恰好 10 分钟（默认窗口），按闭区间合并为一个批次
    const batches = await listBatches(user.userId);
    expect(batches).toHaveLength(1);
    const items = await listBatchItemsWithNames(batches[0]!.id);
    expect(items.map((i) => i.submarine_name).sort()).toEqual(['U1', 'U2']);
    expect(batches[0]!.notify_at).toBe(t0 + 1200);
  });

  it('相同内容重复上传会被去重', async () => {
    const user = await register();
    const payload = JSON.stringify(syncBody('2002', [{ slotIndex: 0, name: 'U1', returnAt: now() + 900 }]));

    const first = await api('/submarines/sync', { method: 'POST', token: user.token, body: payload });
    const second = await api('/submarines/sync', { method: 'POST', token: user.token, body: payload });

    expect(first.body.data.deduped).toBe(false);
    expect(second.body.data.deduped).toBe(true);
    expect(second.body.data.changed).toBe(0);
    expect(second.body.data.accepted).toBe(0);
  });

  it('返航时间更新会重排批次', async () => {
    const user = await register();
    const t0 = now();

    await api('/submarines/sync', {
      method: 'POST',
      token: user.token,
      body: JSON.stringify(syncBody('2003', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }])),
    });
    const before = await listBatches(user.userId);
    expect(before).toHaveLength(1);
    const firstNotifyAt = before[0]!.notify_at;

    const updated = await api('/submarines/sync', {
      method: 'POST',
      token: user.token,
      body: JSON.stringify(syncBody('2003', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 3600 }])),
    });
    expect(updated.body.data.changed).toBe(1);

    const after = await listBatches(user.userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.notify_at).toBe(firstNotifyAt + 3000);
    const items = await listBatchItemsWithNames(after[0]!.id);
    expect(items).toHaveLength(1);
  });

  it('槽位消失时软删除潜艇并取消对应批次', async () => {
    const user = await register();
    const t0 = now();

    await api('/submarines/sync', {
      method: 'POST',
      token: user.token,
      body: JSON.stringify(
        syncBody('2004', [
          { slotIndex: 0, name: 'U1', returnAt: t0 + 600 },
          { slotIndex: 1, name: 'U2', returnAt: t0 + 3600 },
        ]),
      ),
    });
    expect(await listBatches(user.userId)).toHaveLength(2);

    const result = await api('/submarines/sync', {
      method: 'POST',
      token: user.token,
      body: JSON.stringify(syncBody('2004', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }])),
    });
    expect(result.body.data.removed).toBe(1);

    const list = await api('/submarines', { token: user.token });
    expect(list.body.data.submarines).toHaveLength(1);
    expect(await listBatches(user.userId)).toHaveLength(1);
  });

  it('拒绝不合理或格式错误的返航时间', async () => {
    const user = await register();
    const t0 = now();

    const invalid = await api('/submarines/sync', {
      method: 'POST',
      token: user.token,
      body: JSON.stringify(syncBody('2005', [{ slotIndex: 0, name: 'U1', returnAt: 12.5 }])),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error?.code).toBe('VALIDATION_ERROR');

    const tooFar = await api('/submarines/sync', {
      method: 'POST',
      token: user.token,
      body: JSON.stringify(syncBody('2005', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 30 * 86400 }])),
    });
    expect(tooFar.status).toBe(200);
    // 超范围项被跳过并返回 warning，不会入库
    expect(tooFar.body.data.accepted).toBe(0);
    expect(tooFar.body.data.warnings).toHaveLength(1);
  });

  it('最多接受 4 个槽位', async () => {
    const user = await register();
    const t0 = now();
    const five = [0, 1, 2, 3, 4].map((slotIndex) => ({ slotIndex, name: `S${slotIndex}`, returnAt: t0 + 600 }));
    const { status, body } = await api('/submarines/sync', {
      method: 'POST',
      token: user.token,
      body: JSON.stringify(syncBody('2006', five)),
    });

    expect(status).toBe(400);
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('无效 token 不能同步', async () => {
    const { status } = await api('/submarines/sync', {
      method: 'POST',
      token: 'srk_doesnotexist123456789012',
      body: JSON.stringify(syncBody('2007', [{ slotIndex: 0, name: 'U1', returnAt: now() + 600 }])),
    });
    expect(status).toBe(401);
  });

  it('删除潜艇接口会移除批次', async () => {
    const user = await register();
    const t0 = now();
    await api('/submarines/sync', {
      method: 'POST',
      token: user.token,
      body: JSON.stringify(syncBody('2008', [{ slotIndex: 0, name: 'U1', returnAt: t0 + 600 }])),
    });

    const list = await api('/submarines', { token: user.token });
    const submarineId = list.body.data.submarines[0].id;

    const removed = await api('/submarines/remove', {
      method: 'POST',
      token: user.token,
      body: JSON.stringify({ submarineId }),
    });
    expect(removed.status).toBe(200);
    expect(removed.body.data.removed).toBe(1);

    expect((await api('/submarines', { token: user.token })).body.data.submarines).toHaveLength(0);
    expect(await listBatches(user.userId)).toHaveLength(0);

    const again = await api('/submarines/remove', {
      method: 'POST',
      token: user.token,
      body: JSON.stringify({ submarineId }),
    });
    expect(again.status).toBe(404);
  });

  it('不能删除其他用户的潜艇', async () => {
    const alice = await register();
    const bob = await register();
    await api('/submarines/sync', {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify(syncBody('2009', [{ slotIndex: 0, name: 'U1', returnAt: now() + 600 }])),
    });
    const aliceSub = (await api('/submarines', { token: alice.token })).body.data.submarines[0];

    const attempt = await api('/submarines/remove', {
      method: 'POST',
      token: bob.token,
      body: JSON.stringify({ submarineId: aliceSub.id }),
    });
    expect(attempt.status).toBe(404);
    expect((await api('/submarines', { token: alice.token })).body.data.submarines).toHaveLength(1);
  });
});

describe('状态推导', () => {
  it('returnAt=0 视为停靠，过期视为已返航', async () => {
    const user = await register();
    const t0 = now();
    await api('/submarines/sync', {
      method: 'POST',
      token: user.token,
      body: JSON.stringify(
        syncBody('2010', [
          { slotIndex: 0, name: 'Docked', returnAt: 0 },
          { slotIndex: 1, name: 'Returned', returnAt: t0 - 120 },
          { slotIndex: 2, name: 'Sailing', returnAt: t0 + 600 },
        ]),
      ),
    });

    const states = (await api('/submarines', { token: user.token })).body.data.submarines.map(
      (s: { state: string; name: string }) => `${s.name}:${s.state}`,
    );
    expect(states.sort()).toEqual(['Docked:docked', 'Returned:returned', 'Sailing:sailing']);
  });
});

describe('旧快照保护（同一账号在不同设备/地点登录）', () => {
  const syncAt = (token: string, body: object) =>
    api('/submarines/sync', { method: 'POST', token, body: JSON.stringify(body) });

  function bodyWithCollectedAt(characterId: string, collectedAt: number, sub: { slotIndex: number; name: string; returnAt: number }) {
    return { ...syncBody(characterId, [sub]), collectedAt };
  }

  it('采集时刻更早的上报不会覆盖已有数据', async () => {
    const user = await register();
    const t0 = now();

    await syncAt(user.token, bodyWithCollectedAt('3001', t0, { slotIndex: 0, name: 'U1', returnAt: t0 + 3600 }));

    const stale = await syncAt(user.token, bodyWithCollectedAt('3001', t0 - 600, { slotIndex: 0, name: 'U1', returnAt: t0 + 600 }));

    expect(stale.status).toBe(200);
    expect(stale.body.data.stale).toBe(true);
    expect(stale.body.data.accepted).toBe(0);
    expect(stale.body.data.changed).toBe(0);

    const list = await api('/submarines', { token: user.token });
    expect(list.body.data.submarines[0].returnAt).toBe(t0 + 3600);
  });

  it('旧快照不会取消已有的通知批次', async () => {
    const user = await register();
    const t0 = now();

    await syncAt(user.token, bodyWithCollectedAt('3002', t0, { slotIndex: 0, name: 'U1', returnAt: t0 + 3600 }));
    expect(await listBatches(user.userId)).toHaveLength(1);
    const before = await listBatches(user.userId);

    await syncAt(user.token, bodyWithCollectedAt('3002', t0 - 600, { slotIndex: 0, name: 'U1', returnAt: t0 + 600 }));

    const after = await listBatches(user.userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.notify_at).toBe(before[0]!.notify_at);
  });

  it('旧快照不会把未出现的槽位当成已删除', async () => {
    const user = await register();
    const t0 = now();

    await syncAt(
      user.token,
      {
        ...syncBody('3003', [
          { slotIndex: 0, name: 'U1', returnAt: t0 + 1200 },
          { slotIndex: 1, name: 'U2', returnAt: t0 + 3600 },
        ]),
        collectedAt: t0,
      },
    );
    expect((await api('/submarines', { token: user.token })).body.data.submarines).toHaveLength(2);

    // 旧快照里只有 1 号槽位
    const stale = await syncAt(user.token, bodyWithCollectedAt('3003', t0 - 600, { slotIndex: 0, name: 'U1', returnAt: t0 + 600 }));

    expect(stale.body.data.removed).toBe(0);
    expect((await api('/submarines', { token: user.token })).body.data.submarines).toHaveLength(2);
  });

  it('采集时刻更新的上报正常覆盖', async () => {
    const user = await register();
    const t0 = now();

    await syncAt(user.token, bodyWithCollectedAt('3004', t0 - 600, { slotIndex: 0, name: 'U1', returnAt: t0 + 600 }));
    const fresh = await syncAt(user.token, bodyWithCollectedAt('3004', t0, { slotIndex: 0, name: 'U1', returnAt: t0 + 3600 }));

    expect(fresh.body.data.stale).toBe(false);
    expect(fresh.body.data.changed).toBe(1);

    const list = await api('/submarines', { token: user.token });
    expect(list.body.data.submarines[0].returnAt).toBe(t0 + 3600);
  });

  it('采集时刻相同时后到者生效（避免两台设备互相卡住）', async () => {
    const user = await register();
    const t0 = now();

    await syncAt(user.token, bodyWithCollectedAt('3005', t0, { slotIndex: 0, name: 'U1', returnAt: t0 + 600 }));
    const same = await syncAt(user.token, bodyWithCollectedAt('3005', t0, { slotIndex: 0, name: 'U1', returnAt: t0 + 1800 }));

    expect(same.body.data.stale).toBe(false);
    expect((await api('/submarines', { token: user.token })).body.data.submarines[0].returnAt).toBe(t0 + 1800);
  });

  it('按客户端时钟偏差校正后再比较新旧', async () => {
    const user = await register();
    const t0 = now();

    // 第一台设备时钟准确
    await syncAt(user.token, bodyWithCollectedAt('3006', t0, { slotIndex: 0, name: 'U1', returnAt: t0 + 3600 }));

    // 第二台设备本机时钟慢 300 秒：collectedAt 看起来更早，校正后才是真实时刻
    const skewed = await syncAt(user.token, {
      ...bodyWithCollectedAt('3006', t0 - 300, { slotIndex: 0, name: 'U1', returnAt: t0 + 600 }),
      clientTimeOffsetMs: 300_000,
    });

    expect(skewed.body.data.stale).toBe(false);
    expect(skewed.body.data.changed).toBe(1);
    expect((await api('/submarines', { token: user.token })).body.data.submarines[0].returnAt).toBe(t0 + 600);
  });

  it('未上报采集时刻（旧版客户端）不做新旧判断，保持后到者生效', async () => {
    const user = await register();
    const t0 = now();

    await syncAt(user.token, { ...bodyWithCollectedAt('3007', 0, { slotIndex: 0, name: 'U1', returnAt: t0 + 600 }) });
    const second = await syncAt(user.token, { ...bodyWithCollectedAt('3007', 0, { slotIndex: 0, name: 'U1', returnAt: t0 + 1800 }) });

    expect(second.body.data.stale).toBe(false);
    expect((await api('/submarines', { token: user.token })).body.data.submarines[0].returnAt).toBe(t0 + 1800);
  });

  it('偏差大得离谱的采集时刻视为不可判定，不丢弃数据', async () => {
    const user = await register();
    const t0 = now();

    await syncAt(user.token, bodyWithCollectedAt('3008', t0, { slotIndex: 0, name: 'U1', returnAt: t0 + 600 }));

    // 本机时钟差了一天以上：校正后仍远离 now，截断为 0 → 不做陈旧判定
    const weird = await syncAt(user.token, {
      ...bodyWithCollectedAt('3008', 1, { slotIndex: 0, name: 'U1', returnAt: t0 + 1800 }),
      clientTimeOffsetMs: 0,
    });

    expect(weird.body.data.stale).toBe(false);
    expect((await api('/submarines', { token: user.token })).body.data.submarines[0].returnAt).toBe(t0 + 1800);
  });
});

describe('多设备旧快照不会复活已失效的槽位', () => {
  const syncAt = (token: string, body: object) =>
    api('/submarines/sync', { method: 'POST', token, body: JSON.stringify(body) });

  // 采集时刻取"过去"，因为云端会把未来时刻截断到 now ——
  // 未来时刻会让两台设备的采集时刻被压成同一个值，掩盖真实的先后关系。
  const collected = () => now() - 300;

  it('旧设备再次上报已停用的槽位时，不会让潜水艇重新出现', async () => {
    const user = await register();
    const c0 = collected();
    const r0 = now() + 1200;

    // 设备 A：两个槽位
    await syncAt(user.token, {
      ...syncBody('3101', [
        { slotIndex: 0, name: 'U1', returnAt: r0 },
        { slotIndex: 1, name: 'U2', returnAt: r0 + 3600 },
      ]),
      collectedAt: c0,
    });

    // 设备 B（采集时刻更晚）：槽位 1 已不存在
    const fresh = await syncAt(user.token, {
      ...syncBody('3101', [{ slotIndex: 0, name: 'U1', returnAt: r0 }]),
      collectedAt: c0 + 60,
    });
    expect(fresh.body.data.removed).toBe(1);
    expect((await api('/submarines', { token: user.token })).body.data.submarines).toHaveLength(1);

    // 设备 A 又用旧快照上报，里面仍带着槽位 1
    const stale = await syncAt(user.token, {
      ...syncBody('3101', [
        { slotIndex: 0, name: 'U1', returnAt: r0 },
        { slotIndex: 1, name: 'U2', returnAt: r0 + 3600 },
      ]),
      collectedAt: c0,
    });

    expect(stale.body.data.stale).toBe(true);
    const after = await api('/submarines', { token: user.token });
    expect(after.body.data.submarines).toHaveLength(1);
    expect(after.body.data.submarines[0].slotIndex).toBe(0);
  });

  it('潜水艇被云端删除后，旧设备上报不会把它重新激活', async () => {
    const user = await register();
    const c0 = collected();
    const r0 = now() + 1200;

    await syncAt(user.token, {
      ...syncBody('3102', [
        { slotIndex: 0, name: 'U1', returnAt: r0 },
        { slotIndex: 1, name: 'U2', returnAt: r0 + 3600 },
      ]),
      collectedAt: c0,
    });

    // 设备 B 采集到更新的返航时间，随后用户手动删掉槽位 1
    await syncAt(user.token, {
      ...syncBody('3102', [
        { slotIndex: 0, name: 'U1', returnAt: r0 + 600 },
        { slotIndex: 1, name: 'U2', returnAt: r0 + 3600 },
      ]),
      collectedAt: c0 + 60,
    });
    const removal = await api('/submarines/remove', {
      method: 'POST',
      token: user.token,
      body: JSON.stringify({ characterId: '3102', slotIndex: 1 }),
    });
    expect(removal.status).toBe(200);
    expect((await api('/submarines', { token: user.token })).body.data.submarines).toHaveLength(1);

    // 设备 A 的旧快照（两个槽位都是旧数据）整体被丢弃
    const stale = await syncAt(user.token, {
      ...syncBody('3102', [
        { slotIndex: 0, name: 'U1', returnAt: r0 },
        { slotIndex: 1, name: 'U2', returnAt: r0 + 3600 },
      ]),
      collectedAt: c0,
    });

    expect(stale.body.data.stale).toBe(true);
    const after = await api('/submarines', { token: user.token });
    expect(after.body.data.submarines).toHaveLength(1);
    // 槽位 0 保留设备 B 的新返航时间
    expect(after.body.data.submarines[0].returnAt).toBe(r0 + 600);
  });

  it('设备恢复后采集到新数据时仍可正常写入', async () => {
    const user = await register();
    const c0 = collected();
    const r0 = now() + 1200;

    await syncAt(user.token, {
      ...syncBody('3103', [
        { slotIndex: 0, name: 'U1', returnAt: r0 },
        { slotIndex: 1, name: 'U2', returnAt: r0 + 3600 },
      ]),
      collectedAt: c0,
    });
    await syncAt(user.token, {
      ...syncBody('3103', [{ slotIndex: 0, name: 'U1', returnAt: r0 }]),
      collectedAt: c0 + 60,
    });

    // 设备 A 重新采集（采集时刻更新）后，槽位 1 属于正常的新事实
    const refreshed = await syncAt(user.token, {
      ...syncBody('3103', [
        { slotIndex: 0, name: 'U1', returnAt: r0 },
        { slotIndex: 1, name: 'U2', returnAt: r0 + 7200 },
      ]),
      collectedAt: c0 + 120,
    });

    expect(refreshed.body.data.stale).toBe(false);
    expect(refreshed.body.data.changed).toBeGreaterThan(0);
    expect((await api('/submarines', { token: user.token })).body.data.submarines).toHaveLength(2);
  });
});

describe('同一账号的多台设备共用一份数据', () => {
  const syncAt = (token: string, body: object) =>
    api('/submarines/sync', { method: 'POST', token, body: JSON.stringify(body) });

  /** 用第一台设备的 token 为同一用户签发第二台设备 */
  async function addDevice(token: string, deviceName: string): Promise<string> {
    const created = await api('/auth/device', {
      method: 'POST',
      token,
      body: JSON.stringify({ deviceName }),
    });
    expect(created.status).toBe(201);
    return created.body.data.token as string;
  }

  it('新设备签发的 token 与首台设备属于同一用户', async () => {
    const first = await register('设备A');
    const secondToken = await addDevice(first.token, '设备B');

    const who = await api('/auth/whoami', { token: secondToken });
    expect(who.body.data.userId).toBe(first.userId);
    expect(who.body.data.devices).toHaveLength(2);
    expect(who.body.data.devices.map((d: { name: string }) => d.name).sort()).toEqual(['设备A', '设备B']);
  });

  it('两台设备各自上报，数据合并到同一份潜水艇列表', async () => {
    const first = await register('设备A');
    const secondToken = await addDevice(first.token, '设备B');
    const c0 = now() - 300;
    const r0 = now() + 1200;

    // 设备 A 只看到槽位 0
    await syncAt(first.token, {
      ...syncBody('3201', [{ slotIndex: 0, name: 'U1', returnAt: r0 }]),
      collectedAt: c0,
    });
    // 设备 B（采集更晚）看到槽位 0 的新时间与槽位 1
    const merged = await syncAt(secondToken, {
      ...syncBody('3201', [
        { slotIndex: 0, name: 'U1', returnAt: r0 + 600 },
        { slotIndex: 1, name: 'U2', returnAt: r0 + 3600 },
      ]),
      collectedAt: c0 + 120,
    });

    expect(merged.body.data.stale).toBe(false);
    expect(merged.body.data.accepted).toBe(2);

    // 任一设备的 token 读到的都是同一份数据
    for (const token of [first.token, secondToken]) {
      const list = await api('/submarines', { token });
      const subs = list.body.data.submarines as Array<{ slotIndex: number; returnAt: number }>;
      expect(subs).toHaveLength(2);
      expect(subs.find((s) => s.slotIndex === 0)!.returnAt).toBe(r0 + 600);
    }
  });

  it('推送设置由同一账号共享', async () => {
    const first = await register('设备A');
    const secondToken = await addDevice(first.token, '设备B');

    const saved = await api('/settings', {
      method: 'PUT',
      token: secondToken,
      body: JSON.stringify({ timezone: 'Asia/Tokyo', mergeWindowMinutes: 30 }),
    });
    expect(saved.status).toBe(200);

    const readFromFirst = await api('/settings', { token: first.token });
    expect(readFromFirst.body.data.timezone).toBe('Asia/Tokyo');
    expect(readFromFirst.body.data.mergeWindowMinutes).toBe(30);
  });

  it('旧设备上报已删除的槽位不会覆盖新设备的数据', async () => {
    const first = await register('设备A');
    const secondToken = await addDevice(first.token, '设备B');
    const c0 = now() - 300;
    const r0 = now() + 1200;

    await syncAt(first.token, {
      ...syncBody('3202', [
        { slotIndex: 0, name: 'U1', returnAt: r0 },
        { slotIndex: 1, name: 'U2', returnAt: r0 + 3600 },
      ]),
      collectedAt: c0,
    });

    // 设备 B 看到槽位 1 已经不在（更晚的采集时刻）
    await syncAt(secondToken, {
      ...syncBody('3202', [{ slotIndex: 0, name: 'U1', returnAt: r0 }]),
      collectedAt: c0 + 120,
    });

    // 设备 A 拿旧快照回来，整批都被判定为陈旧
    const stale = await syncAt(first.token, {
      ...syncBody('3202', [
        { slotIndex: 0, name: 'U1', returnAt: r0 },
        { slotIndex: 1, name: 'U2', returnAt: r0 + 3600 },
      ]),
      collectedAt: c0,
    });

    expect(stale.body.data.stale).toBe(true);
    expect((await api('/submarines', { token: secondToken })).body.data.submarines).toHaveLength(1);
  });
});
