import type { Repository, UserSettings } from '../storage/repository.js';
import type { BatchRow, MergeEvent } from '../models/index.js';
import { buildBatches, computeAdvanceNotifyAt } from './notification-service.js';

export interface ReplanResult {
  batches: number;
  events: number;
}

export function eventKey(submarineId: string, returnAt: number): string {
  return `ret:${submarineId}:${returnAt}`;
}

/**
 * 重算该用户所有未发送批次：
 *  1. 取消并清空现有 pending 批次（已发送批次不受影响）；
 *  2. 从 active 潜艇收集"尚未通知过"的返航事件；
 *  3. 按锚点规则合并，写入新批次与成员。
 *
 * 幂等：无事件时不会留下任何 pending 批次。
 */
export async function replan(
  repo: Repository,
  userId: string,
  settings: UserSettings,
  now: number,
): Promise<ReplanResult> {
  await repo.cancelPendingBatches(userId, now);

  const submarines = await repo.listActiveSubmarines(userId);
  const usedKeys = await repo.listEventKeys(userId);

  const events: MergeEvent[] = [];
  for (const sub of submarines) {
    if (sub.return_at <= 0) continue;
    if (usedKeys.has(eventKey(sub.id, sub.return_at))) continue;
    events.push({ submarineId: sub.id, returnAt: sub.return_at });
  }

  const batches = buildBatches(events, settings.mergeWindowMinutes * 60);
  for (const batch of batches) {
    const advanceNotifyAt = computeAdvanceNotifyAt(batch.notifyAt, settings.advanceNotificationMinutes);
    const batchId = await repo.createBatch({
      userId,
      anchorReturnAt: batch.anchorReturnAt,
      latestReturnAt: batch.latestReturnAt,
      notifyAt: batch.notifyAt,
      advanceNotifyAt,
      now,
    });
    for (const item of batch.items) {
      await repo.addBatchItem(batchId, item.submarineId, item.returnAt);
    }
  }

  return { batches: batches.length, events: events.length };
}

/** 批次下一次到期时刻（含重试、提前通知、正式通知） */
export function batchNextDue(batch: BatchRow): number | null {
  let min: number | null = null;
  const consider = (value: number | null | undefined) => {
    if (value === null || value === undefined) return;
    if (min === null || value < min) min = value;
  };
  consider(batch.next_retry_at);
  if (batch.advance_notify_at !== null && batch.advanced_sent_at === null) consider(batch.advance_notify_at);
  if (batch.status === 'pending') consider(batch.notify_at);
  return min;
}

export function nextAlarmTime(batches: readonly BatchRow[]): number | null {
  let min: number | null = null;
  for (const batch of batches) {
    const due = batchNextDue(batch);
    if (due !== null && (min === null || due < min)) min = due;
  }
  return min;
}
