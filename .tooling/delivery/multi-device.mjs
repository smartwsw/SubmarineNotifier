// 多设备联调：真实 HTTP + 真实 D1，验证同一账号两台设备的合并与旧快照保护。
//  1. 用设备 A 的 token 签发设备 B，两者属于同一用户；
//  2. 两台设备各自上报 → 云端合并成同一份潜水艇列表；
//  3. 设备 B 未打开工坊 → 不上报，云端保留设备 A 的数据；
//  4. 设备 A 拿旧快照回来 → stale，不覆盖、不复活已删除的槽位。
//
// 用法（先起 wrangler dev --local）：
//   node .tooling/delivery/multi-device.mjs http://127.0.0.1:8787
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures += 1;
}

const nowSec = () => Math.floor(Date.now() / 1000);

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, data: json?.data };
}

const accountFile = new URL(process.env.MULTI_DEVICE_ACCOUNT ?? './account-multi-device.json', import.meta.url);

async function register(name) {
  if (existsSync(accountFile)) {
    const saved = JSON.parse(readFileSync(accountFile, 'utf8'));
    const who = await api('/api/v1/auth/whoami', { token: saved.token });
    if (who.status === 200 && who.data?.userId === saved.userId) {
      console.log(`      复用已保存账号 ${saved.userId}`);
      return saved;
    }
  }
  const r = await api('/api/v1/auth/register', { method: 'POST', body: { deviceName: name } });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.json)}`);
  writeFileSync(accountFile, JSON.stringify({ userId: r.data.userId, token: r.data.token }, null, 2));
  return { userId: r.data.userId, token: r.data.token, deviceId: r.data.deviceId };
}

function syncBody(characterId, subs, collectedAt) {
  return {
    characterId,
    characterName: '联调角色',
    worldId: 1001,
    collectedAt,
    submarines: subs.map((s) => ({
      slotIndex: s.slotIndex,
      name: s.name,
      rank: 30,
      returnAt: s.returnAt,
      routePoints: [1, 2],
      parts: { hull: 1, stern: 2, bow: 3, bridge: 4 },
      state: s.returnAt > 0 ? 'sailing' : 'docked',
    })),
  };
}

const user = await register('multi-device');

// 清掉上一轮残留：删除所有潜艇
for (const sub of (await api('/api/v1/submarines', { token: user.token })).data?.submarines ?? []) {
  await api('/api/v1/submarines/remove', {
    method: 'POST',
    token: user.token,
    body: { characterId: sub.characterId, slotIndex: sub.slotIndex },
  });
}

// ============================================================
// 场景 1：签发第二台设备
// ============================================================

const created = await api('/api/v1/auth/device', {
  method: 'POST',
  token: user.token,
  body: { deviceName: '设备B' },
});
check('POST /auth/device 返回新的 deviceId 与 token', created.status === 201 && !!created.data?.token, `status=${created.status}`);
const tokenB = created.data?.token;

const whoB = await api('/api/v1/auth/whoami', { token: tokenB });
check('设备 B 的 token 属于同一用户', whoB.data?.userId === user.userId, `userId=${whoB.data?.userId}`);
check('账号下有两台设备', whoB.data?.devices?.length === 2, `devices=${whoB.data?.devices?.length}`);

// ============================================================
// 场景 2：两台设备各自上报，数据合并
// ============================================================

const charId = '990001';
const c0 = nowSec() - 300;
const r0 = nowSec() + 1800;

await api('/api/v1/submarines/sync', {
  method: 'POST',
  token: user.token,
  body: syncBody(charId, [{ slotIndex: 0, name: 'U1', returnAt: r0 }], c0),
});
const fromB = await api('/api/v1/submarines/sync', {
  method: 'POST',
  token: tokenB,
  body: syncBody(
    charId,
    [
      { slotIndex: 0, name: 'U1', returnAt: r0 + 600 },
      { slotIndex: 1, name: 'U2', returnAt: r0 + 3600 },
    ],
    c0 + 120,
  ),
});
check('设备 B 的新数据被接受', fromB.data?.stale === false && fromB.data?.accepted === 2, JSON.stringify(fromB.data));

const listA = await api('/api/v1/submarines', { token: user.token });
const listB = await api('/api/v1/submarines', { token: tokenB });
check('两台设备读到同一份数据（2 艘）', listA.data?.submarines?.length === 2 && listB.data?.submarines?.length === 2,
  `A=${listA.data?.submarines?.length} B=${listB.data?.submarines?.length}`);
const slot0 = listA.data?.submarines?.find((s) => s.slotIndex === 0);
check('槽位 0 取设备 B 的较新返航时间', slot0?.returnAt === r0 + 600, `returnAt=${slot0?.returnAt} expected=${r0 + 600}`);

// ============================================================
// 场景 3：设置共享
// ============================================================

await api('/api/v1/settings', {
  method: 'PUT',
  token: tokenB,
  body: { timezone: 'Asia/Tokyo', mergeWindowMinutes: 25 },
});
const settingsA = await api('/api/v1/settings', { token: user.token });
check('推送设置由同一账号共享', settingsA.data?.timezone === 'Asia/Tokyo' && settingsA.data?.mergeWindowMinutes === 25,
  `timezone=${settingsA.data?.timezone} window=${settingsA.data?.mergeWindowMinutes}`);
// 复位，避免影响其他联调
await api('/api/v1/settings', { method: 'PUT', token: user.token, body: { timezone: 'Asia/Shanghai', mergeWindowMinutes: 10 } });

// ============================================================
// 场景 4：设备 B 未打开工坊 → 不上报，云端保留设备 A 的数据
// ============================================================

// 设备 B "登录但没开工坊"：插件在这种情况下根本不调用 sync（WorkshopLoaded=false），
// 所以这里验证的是"云端在没有 B 的上报时仍保有完整数据"。
const beforeIdle = (await api('/api/v1/submarines', { token: tokenB })).data?.submarines?.length;
check('设备 B 未上报时云端数据不丢', beforeIdle === 2, `count=${beforeIdle}`);

// ============================================================
// 场景 5：旧快照不覆盖、不复活
// ============================================================

// 设备 B（采集更晚）看到槽位 1 已消失
const removalObserved = await api('/api/v1/submarines/sync', {
  method: 'POST',
  token: tokenB,
  body: syncBody(charId, [{ slotIndex: 0, name: 'U1', returnAt: r0 + 600 }], c0 + 180),
});
check('设备 B 观察到槽位 1 消失', removalObserved.data?.removed === 1, JSON.stringify(removalObserved.data));

// 设备 A 用旧快照回来，仍带着槽位 1
const stale = await api('/api/v1/submarines/sync', {
  method: 'POST',
  token: user.token,
  body: syncBody(
    charId,
    [
      { slotIndex: 0, name: 'U1', returnAt: r0 },
      { slotIndex: 1, name: 'U2', returnAt: r0 + 3600 },
    ],
    c0,
  ),
});
check('旧设备的整批上报被判定为 stale', stale.data?.stale === true, JSON.stringify(stale.data));
check('旧快照未复活已删除的槽位', stale.data?.accepted === 0 && stale.data?.removed === 0,
  `accepted=${stale.data?.accepted} removed=${stale.data?.removed}`);

const afterStale = await api('/api/v1/submarines', { token: tokenB });
check('潜水艇列表仍只有 1 艘', afterStale.data?.submarines?.length === 1, `count=${afterStale.data?.submarines?.length}`);
check('槽位 0 仍是设备 B 的新返航时间', afterStale.data?.submarines?.[0]?.returnAt === r0 + 600,
  `returnAt=${afterStale.data?.submarines?.[0]?.returnAt}`);

// ============================================================
// 场景 6：设备恢复后新数据仍可写入
// ============================================================

const recovered = await api('/api/v1/submarines/sync', {
  method: 'POST',
  token: user.token,
  body: syncBody(
    charId,
    [
      { slotIndex: 0, name: 'U1', returnAt: r0 + 600 },
      { slotIndex: 1, name: 'U2', returnAt: r0 + 7200 },
    ],
    c0 + 240,
  ),
});
check('设备恢复后新数据可以正常写入', recovered.data?.stale === false && (recovered.data?.accepted ?? 0) > 0,
  JSON.stringify(recovered.data));
check('恢复后槽位 1 重新出现', ((await api('/api/v1/submarines', { token: user.token })).data?.submarines?.length ?? 0) === 2);

// 清理
for (const sub of (await api('/api/v1/submarines', { token: user.token })).data?.submarines ?? []) {
  await api('/api/v1/submarines/remove', {
    method: 'POST',
    token: user.token,
    body: { characterId: sub.characterId, slotIndex: sub.slotIndex },
  });
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
