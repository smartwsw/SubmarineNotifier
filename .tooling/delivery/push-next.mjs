// 「立即发送下次返航」联调：真实 HTTP + 真实 Scheduler DO + 假 Bark。
// 验证三件事：
//  1. 按钮对应的接口能按真实批次内容立刻推送；
//  2. 推送不改动排程——批次仍待发，之后正式通知照常再来一条；
//  3. 边界：无批次 409、关闭通知 400、空批次不会被当成"下次返航"。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const bark = process.argv[3] ?? 'http://127.0.0.1:8790';

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const accountFile = new URL(process.env.PUSH_NEXT_ACCOUNT ?? './account-push-next.json', import.meta.url);

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
  return r.data;
}

async function configurePush(token, overrides = {}) {
  const r = await api('/api/v1/settings', {
    method: 'PUT',
    token,
    body: {
      notificationEnabled: true,
      provider: 'bark',
      providerServerUrl: bark,
      providerToken: 'push-next-device-key',
      mergeWindowMinutes: 10,
      advanceNotificationMinutes: 0,
      notifyTitle: '潜水艇返航',
      timezone: 'Asia/Shanghai',
      ...overrides,
    },
  });
  if (r.status !== 200) throw new Error(`settings failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.data;
}

async function sync(token, characterId, subs) {
  return await api('/api/v1/submarines/sync', {
    method: 'POST',
    token,
    body: {
      characterId,
      characterName: '联调角色',
      worldId: 1001,
      collectedAt: nowSec(),
      submarines: subs.map((s) => ({
        slotIndex: s.slotIndex,
        name: s.name,
        rank: 30,
        returnAt: s.returnAt,
        routePoints: [1, 2],
        parts: { hull: 1, stern: 2, bow: 3, bridge: 4 },
        state: s.returnAt > 0 ? 'sailing' : 'docked',
      })),
    },
  });
}

async function received() {
  const res = await fetch(`${bark}/_received`);
  return await res.json();
}

async function waitFor(fn, { timeoutMs = 120_000, intervalMs = 1000, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  console.log(`      (等待超时: ${label}, ${Math.round((Date.now() - start) / 1000)}s)`);
  return false;
}

function formatLocal(unix) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(unix * 1000));
}

const user = await register('push-next');
const token = user.token;
await configurePush(token);

// 清空上一轮残留的排程与潜艇
const existing = await api('/api/v1/submarines', { token });
for (const sub of existing.data?.submarines ?? []) {
  await api('/api/v1/submarines/remove', {
    method: 'POST',
    token,
    body: { characterId: sub.characterId, slotIndex: sub.slotIndex },
  });
}

// ============================================================
// 场景 1：没有待发批次时返回 409
// ============================================================
console.log('\n=== 场景 1：无待发批次 ===');
const empty = await api('/api/v1/push/next', { method: 'POST', token });
check('无批次时返回 409 NO_UPCOMING_RETURN',
  empty.status === 409 && empty.json?.error?.code === 'NO_UPCOMING_RETURN',
  `${empty.status} ${JSON.stringify(empty.json?.error)}`);

// ============================================================
// 场景 2：立即发送下次返航，且不影响真实排程
// ============================================================
console.log('\n=== 场景 2：立即发送下次返航 ===');
const t = nowSec();
const returnAtA = t + 90;
const returnAtB = t + 100;
const baseCount = (await received()).count;

const syncRes = await sync(token, '18014400000000011', [
  { slotIndex: 0, name: '立即一号', returnAt: returnAtA },
  { slotIndex: 1, name: '立即二号', returnAt: returnAtB },
]);
check('同步成功', syncRes.status === 200 && syncRes.data?.changed >= 1,
  `changed=${syncRes.data?.changed}`);

const statusBefore = await api('/api/v1/status', { token });
check('排程含一个待发批次',
  statusBefore.data?.scheduler?.pendingBatches === 1,
  `batches=${statusBefore.data?.scheduler?.pendingBatches}`);

const pushed = await api('/api/v1/push/next', { method: 'POST', token });
check('接口返回 200 且已投递',
  pushed.status === 200 && pushed.data?.delivered === true,
  `${pushed.status} ${JSON.stringify(pushed.data)}`);
check('返回的排程信息与真实批次一致',
  pushed.data?.returnAt === returnAtB && pushed.data?.shipCount === 2 && pushed.data?.kind === 'returned',
  JSON.stringify(pushed.data));
check('响应里不含 device key',
  !JSON.stringify(pushed.json).includes('push-next-device-key'));

const afterPush = await received();
check('假 Bark 收到 1 条推送', afterPush.count === baseCount + 1, `count=${afterPush.count}`);
const pushBody = afterPush.entries[baseCount]?.body;
if (pushBody) {
  check('通知正文含两艘艇', String(pushBody.body).includes('立即一号') && String(pushBody.body).includes('立即二号'),
    JSON.stringify(pushBody.body));
  check('通知使用正常标题与分组', pushBody.title === '潜水艇返航' && pushBody.group === 'FF14',
    `title=${pushBody.title} group=${pushBody.group}`);
  check('通知正文时间为返航时刻',
    String(pushBody.body).includes(formatLocal(returnAtA)) && String(pushBody.body).includes(formatLocal(returnAtB)),
    `${formatLocal(returnAtA)} / ${formatLocal(returnAtB)}`);
  check('使用配置的 device_key', pushBody.device_key === 'push-next-device-key');
}

// 排程未被消耗
const statusAfterPush = await api('/api/v1/status', { token });
check('推送后排程仍有一个待发批次',
  statusAfterPush.data?.scheduler?.pendingBatches === 1,
  `batches=${statusAfterPush.data?.scheduler?.pendingBatches}`);
check('下次 alarm 仍是真实返航时刻',
  statusAfterPush.data?.scheduler?.nextAlarmAt === returnAtB,
  `next=${statusAfterPush.data?.scheduler?.nextAlarmAt} expect=${returnAtB}`);

const logsAfterPush = await api('/api/v1/logs?limit=20', { token });
const nextLogs = (logsAfterPush.data?.logs ?? []).filter((l) => l.eventType === 'next');
check('留下一条 next 审计日志且状态 sent',
  nextLogs.length === 1 && nextLogs[0].status === 'sent',
  JSON.stringify(nextLogs));
check('next 日志不占用 returned 幂等键',
  (logsAfterPush.data?.logs ?? []).filter((l) => l.eventType === 'returned').length === 0);

// ============================================================
// 场景 3：到点后正式通知照常发送（只多一条，不会重复）
// ============================================================
console.log('\n=== 场景 3：真实通知仍按计划发送 ===');
const gotReturned = await waitFor(async () => (await received()).count >= baseCount + 2, {
  timeoutMs: 150_000,
  label: '正式返航通知',
});
const final = await received();
check('正式通知已投递', gotReturned && final.count === baseCount + 2, `count=${final.count}`);
const realPush = final.entries[baseCount + 1]?.body;
if (realPush) {
  check('正式通知内容与预览一致',
    String(realPush.body).includes('立即一号') && String(realPush.body).includes('2 艘潜水艇已返航'),
    JSON.stringify(realPush.body));
}

const logsFinal = await api('/api/v1/logs?limit=20', { token });
const returnedLogs = (logsFinal.data?.logs ?? []).filter((l) => l.eventType === 'returned');
check('returned 事件仍按潜艇逐条记录（预览没有消耗它们）',
  returnedLogs.length === 2 && returnedLogs.every((l) => l.status === 'sent'),
  JSON.stringify(returnedLogs.map((l) => `${l.eventType}/${l.status}`)));

const statusFinal = await api('/api/v1/status', { token });
check('投递后无待发批次',
  statusFinal.data?.scheduler?.pendingBatches === 0,
  `batches=${statusFinal.data?.scheduler?.pendingBatches}`);

// ============================================================
// 场景 4：关闭通知时拒绝发送
// ============================================================
console.log('\n=== 场景 4：关闭通知 ===');
await sync(token, '18014400000000012', [{ slotIndex: 0, name: '关闭测试', returnAt: nowSec() + 600 }]);
await configurePush(token, { notificationEnabled: false });
const disabledCount = (await received()).count;
const disabled = await api('/api/v1/push/next', { method: 'POST', token });
check('关闭通知后返回 400 NOTIFICATIONS_DISABLED',
  disabled.status === 400 && disabled.json?.error?.code === 'NOTIFICATIONS_DISABLED',
  `${disabled.status} ${JSON.stringify(disabled.json?.error)}`);
await sleep(500);
check('未产生推送', (await received()).count === disabledCount);

// ============================================================
// 清理
// ============================================================
await api('/api/v1/account', { method: 'DELETE', token, body: { confirm: 'DELETE' } });

console.log();
console.log(failures === 0 ? '「立即发送下次返航」联调全部通过' : `联调失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
