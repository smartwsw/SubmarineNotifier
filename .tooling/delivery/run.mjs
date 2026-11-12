// Phase 5 投递链路联调：验证合并、提前通知、正式返航通知、Bark 失败重试。
// 不启动插件——通知完全由云端 Scheduler DO 的 alarm 触发，
// 因此这也验证了"游戏关闭后通知仍可正常执行"。
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

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

// 注册接口按 IP 限流（5 次/小时）。联调重复执行时复用已保存的账号，
// 只有账号失效或不存在时才真正注册。
const accountFile = new URL(process.env.PHASE5_ACCOUNT ?? './account.json', import.meta.url);

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
      providerToken: 'phase5-device-key',
      mergeWindowMinutes: 10,
      advanceNotificationMinutes: 1,
      notifyTitle: '潜水艇返航',
      timezone: 'Asia/Shanghai',
      ...overrides,
    },
  });
  if (r.status !== 200) throw new Error(`settings failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.data;
}

async function sync(token, characterId, subs) {
  const r = await api('/api/v1/submarines/sync', {
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
        state: 'sailing',
      })),
    },
  });
  return r;
}

async function received() {
  const res = await fetch(`${bark}/_received`);
  return await res.json();
}

async function setPlan(plan) {
  await fetch(`${bark}/_control?plan=${encodeURIComponent(plan)}`);
}

async function resetBark() {
  // 用新的输出文件不受支持，改为读取增量：记录起始条数
  return (await received()).count;
}

async function waitFor(fn, { timeoutMs = 180_000, intervalMs = 2000, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  console.log(`      (等待超时: ${label}, ${Math.round((Date.now() - start) / 1000)}s)`);
  return false;
}

// ============================================================
// 场景 A：合并 + 提前通知 + 正式返航通知
// ============================================================
console.log('\n=== 场景 A：批次合并 / 提前通知 / 正式返航 ===');
const userA = await register('phase5-A');  // 场景 A 与 B 共用同一账号以避开注册限流
const tokenA = userA.token;
await configurePush(tokenA);

const t = nowSec();
// 两艘艇相差 10 秒，均在 10 分钟合并窗口内；提前 1 分钟通知
const returnAtA = t + 75;
const returnAtB = t + 85;
const baseCount = await resetBark();

const syncA = await sync(tokenA, '18014400000000001', [
  { slotIndex: 0, name: '合并一号', returnAt: returnAtA },
  { slotIndex: 1, name: '合并二号', returnAt: returnAtB },
]);
check('同步成功', syncA.status === 200 && syncA.data?.changed >= 1,
  `changed=${syncA.data?.changed} deduped=${syncA.data?.deduped}`);

const statusA = await api('/api/v1/status', { token: tokenA });
check('排程只含合并后的一个批次', statusA.data?.scheduler?.pendingBatches === 1,
  `batches=${statusA.data?.scheduler?.pendingBatches} nextAlarmAt=${statusA.data?.scheduler?.nextAlarmAt}`);
check('提前通知时刻早于返航时刻', statusA.data?.scheduler?.nextAlarmAt === returnAtB - 60,
  `next=${statusA.data?.scheduler?.nextAlarmAt} expect=${returnAtB - 60}`);

// 等待提前通知
const gotAdvance = await waitFor(async () => (await received()).count >= baseCount + 1, {
  timeoutMs: 150_000,
  label: '提前通知',
});
const afterAdvance = await received();
const advancePush = afterAdvance.entries[baseCount];
check('提前通知已投递', gotAdvance && !!advancePush, `共 ${afterAdvance.count} 条`);
if (advancePush) {
  const body = advancePush.body;
  check('提前通知标题带（即将返航）', String(body.title).includes('即将返航'), `title=${body.title}`);
  check('提前通知包含两艘艇（合并成功）',
    String(body.body).includes('合并一号') && String(body.body).includes('合并二号'),
    JSON.stringify(body.body));
  check('提前通知使用 device_key 且未混入其它凭据', body.device_key === 'phase5-device-key');
}

// 等待正式返航通知
const gotReturned = await waitFor(async () => (await received()).count >= baseCount + 2, {
  timeoutMs: 150_000,
  label: '正式返航通知',
});
const afterReturned = await received();
const returnedPush = afterReturned.entries[baseCount + 1];
check('正式返航通知已投递', gotReturned && !!returnedPush, `共 ${afterReturned.count} 条`);
if (returnedPush) {
  const body = returnedPush.body;
  check('正式通知标题为默认标题', body.title === '潜水艇返航', `title=${body.title}`);
  check('正式通知合并两艘艇且只发一次',
    String(body.body).includes('合并一号') &&
    String(body.body).includes('合并二号') &&
    String(body.body).includes('2 艘潜水艇已返航'),
    JSON.stringify(body.body));
  check('正式通知时间与返航时间一致',
    String(body.body).includes(formatLocal(returnAtA)) && String(body.body).includes(formatLocal(returnAtB)),
    `${formatLocal(returnAtA)} / ${formatLocal(returnAtB)}`);
}
check('两个事件共 2 条推送（每批次各一条）', afterReturned.count - baseCount === 2,
  `delta=${afterReturned.count - baseCount}`);

const statusAfter = await api('/api/v1/status', { token: tokenA });
check('投递后无待处理批次', statusAfter.data?.scheduler?.pendingBatches === 0,
  `batches=${statusAfter.data?.scheduler?.pendingBatches} alarm=${statusAfter.data?.scheduler?.nextAlarmAt}`);
check('最近通知记录为 returned/sent',
  statusAfter.data?.lastNotification?.eventType === 'returned' &&
  statusAfter.data?.lastNotification?.status === 'sent',
  JSON.stringify(statusAfter.data?.lastNotification));

// 重复 alarm 不应重复推送
const beforeReplan = (await received()).count;
await api('/api/v1/submarines/refresh', { method: 'POST', token: tokenA });
await sleep(3000);
check('重算后不重复推送', (await received()).count === beforeReplan,
  `count=${(await received()).count}`);

// ============================================================
// 场景 B：Bark 失败恢复（5xx 可重试 → 退避后成功）
// ============================================================
console.log('\n=== 场景 B：Bark 失败恢复 ===');
const userB = userA;
const tokenB = userB.token;
await configurePush(tokenB, { advanceNotificationMinutes: 0 });

const countB = (await received()).count;
// 第一次失败，之后（重试时）成功
await setPlan('fail500,ok');

const dueAt = nowSec() - 30; // 立刻到期
const syncB = await sync(tokenB, '18014400000000002', [{ slotIndex: 0, name: '重试一号', returnAt: dueAt }]);
check('同步成功（立即到期）', syncB.status === 200, `changed=${syncB.data?.changed}`);

const gotFirst = await waitFor(async () => (await received()).count >= countB + 1, {
  timeoutMs: 60_000, intervalMs: 1000, label: '首次尝试',
});
check('云端执行了首次推送尝试', gotFirst);

const statusB1 = await api('/api/v1/status', { token: tokenB });
check('失败后批次仍待处理并安排重试',
  statusB1.data?.scheduler?.pendingBatches === 1 && statusB1.data?.lastNotification !== undefined,
  `batches=${statusB1.data?.scheduler?.pendingBatches} last=${JSON.stringify(statusB1.data?.lastNotification)}`);

const gotRetry = await waitFor(async () => {
  const r = await received();
  return r.count >= countB + 2 && r.entries[countB + 1]?.step === 'ok';
}, { timeoutMs: 150_000, intervalMs: 3000, label: '退避后重试成功' });
check('退避后重试成功（Bark 恢复）', gotRetry);

const statusB2 = await api('/api/v1/status', { token: tokenB });
check('恢复后批次已发送',
  statusB2.data?.scheduler?.pendingBatches === 0 &&
  statusB2.data?.lastNotification?.status === 'sent',
  `batches=${statusB2.data?.scheduler?.pendingBatches} last=${JSON.stringify(statusB2.data?.lastNotification)}`);

const logsB = await api('/api/v1/notifications?limit=10', { token: tokenB });
// 场景 A 的通知已投递，lastNotification 可能先是场景 A 的记录；取最近一条 returned 即可
const returnedLog = logsB.data?.notifications?.find((n) => n.eventType === 'returned');
check('通知记录标记为 sent', returnedLog?.status === 'sent', JSON.stringify(returnedLog));

// 把云端实际发出的文案落盘，供插件侧 NotificationPreview 逐字比对
if (advancePush && returnedPush) {
  writeFileSync(
    process.env.PHASE5_ARTIFACT ?? new URL('./cloud-notification.json', import.meta.url),
    JSON.stringify(
      {
        timezone: 'Asia/Shanghai',
        titleTemplate: '潜水艇返航',
        bodyTemplate: '',
        advance: { title: advancePush.body.title, body: advancePush.body.body },
        returned: {
          title: returnedPush.body.title,
          body: returnedPush.body.body,
          lines: [
            { name: '合并一号', returnAt: returnAtA },
            { name: '合并二号', returnAt: returnAtB },
          ],
        },
        advanceLines: [
          { name: '合并一号', returnAt: returnAtA },
          { name: '合并二号', returnAt: returnAtB },
        ],
      },
      null,
      2,
    ),
  );
}

// ============================================================
// 清理
// ============================================================
await api('/api/v1/account', { method: 'DELETE', token: tokenA, body: { confirm: 'DELETE' } });
await api('/api/v1/account', { method: 'DELETE', token: tokenB, body: { confirm: 'DELETE' } });

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

console.log();
console.log(failures === 0 ? '投递链路联调全部通过' : `投递链路联调失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
