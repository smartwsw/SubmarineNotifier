import type { MergeBatch, MergeEvent } from '../models/index.js';
import { MINUTE } from '../utils/time.js';

/**
 * 通知合并（锚点固定、非链式）。
 *
 * 规则：
 *  1. 事件按 returnAt 升序排列；
 *  2. 当前未消费事件中最早者为 anchor；
 *  3. 后续事件满足 returnAt - anchor <= window 并入当前批次；
 *  4. 超出窗口即关闭当前批次，并以该事件为新 anchor；
 *  5. 批次的通知时间 = 批次内最晚返航时间。
 *
 * 注意：比较基准始终是 anchor，而不是"上一个成员"，因此不会产生链式合并。
 * 窗口为 0 时，仅返航时间完全相同的事件会合并在同一批次。
 */
export function buildBatches(events: readonly MergeEvent[], windowSeconds: number): MergeBatch[] {
  if (windowSeconds < 0) throw new RangeError('windowSeconds must be >= 0');
  if (events.length === 0) return [];

  const sorted = [...events].sort((a, b) => a.returnAt - b.returnAt || a.submarineId.localeCompare(b.submarineId));

  const batches: MergeBatch[] = [];
  let current: MergeEvent[] = [];
  let anchor = 0;

  const flush = () => {
    if (current.length === 0) return;
    const latest = current[current.length - 1]!.returnAt;
    batches.push({
      items: current,
      anchorReturnAt: anchor,
      latestReturnAt: latest,
      notifyAt: latest,
    });
    current = [];
  };

  for (const event of sorted) {
    if (current.length === 0) {
      anchor = event.returnAt;
      current.push(event);
      continue;
    }
    if (event.returnAt - anchor <= windowSeconds) {
      current.push(event);
    } else {
      flush();
      anchor = event.returnAt;
      current.push(event);
    }
  }
  flush();

  return batches;
}

/** 提前通知时刻；advanceMinutes 为 0 时返回 null（不发送提前通知） */
export function computeAdvanceNotifyAt(notifyAt: number, advanceMinutes: number): number | null {
  if (advanceMinutes <= 0) return null;
  return notifyAt - advanceMinutes * MINUTE;
}

/** 批次的下一个到期动作描述（供 DO 计算 alarm） */
export type BatchAction =
  | { kind: 'advance'; at: number }
  | { kind: 'returned'; at: number }
  | { kind: 'retry'; at: number };

export function batchDueActions(
  batch: {
    notifyAt: number;
    advanceNotifyAt: number | null;
    advanceSent: boolean;
    sent: boolean;
    nextRetryAt: number | null;
  },
): BatchAction[] {
  const actions: BatchAction[] = [];
  if (batch.nextRetryAt !== null) actions.push({ kind: 'retry', at: batch.nextRetryAt });
  if (!batch.sent) {
    if (batch.advanceNotifyAt !== null && !batch.advanceSent) {
      actions.push({ kind: 'advance', at: batch.advanceNotifyAt });
    }
    actions.push({ kind: 'returned', at: batch.notifyAt });
  }
  return actions;
}

/** 取最早到期时刻，没有则 null */
export function earliestActionAt(actions: readonly BatchAction[]): number | null {
  let min: number | null = null;
  for (const action of actions) {
    if (min === null || action.at < min) min = action.at;
  }
  return min;
}

export interface NoticeLine {
  name: string;
  returnAt: number;
}

export function formatNotification(
  template: { title: string; bodyTemplate: string },
  lines: readonly NoticeLine[],
  kind: 'advance' | 'returned',
  timeZone: string,
  format: (epochSeconds: number, timeZone: string) => string,
): { title: string; body: string } {
  const title = kind === 'advance'
    ? `${template.title}（即将返航）`
    : template.title;

  const count = lines.length;
  if (template.bodyTemplate.trim().length > 0) {
    const rendered = template.bodyTemplate
      .replaceAll('{count}', String(count))
      .replaceAll('{kind}', kind === 'advance' ? '即将返航' : '已返航')
      .replaceAll(
        '{submarines}',
        lines.map((l) => `${l.name} ${format(l.returnAt, timeZone)}`).join('、'),
      );
    return { title, body: rendered.slice(0, 2000) };
  }

  const header = kind === 'advance'
    ? `${count} 艘潜水艇将于 ${format(lines[0]?.returnAt ?? 0, timeZone)} 前后返航`
    : `${count} 艘潜水艇已返航`;
  const detail = lines
    .map((l) => `· ${l.name} — ${format(l.returnAt, timeZone)}`)
    .join('\n');
  return { title: title.slice(0, 120), body: `${header}\n${detail}`.slice(0, 2000) };
}
