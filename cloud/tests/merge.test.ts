import { describe, expect, it } from 'vitest';
import { buildBatches, computeAdvanceNotifyAt } from '../src/services/notification-service.js';

/** 以当天 00:00 为基准构造时间，避免时区/日期影响 */
const base = Date.UTC(2026, 0, 1, 0, 0, 0) / 1000;
const at = (hour: number, minute: number) => base + hour * 3600 + minute * 60;
const MIN_10 = 10 * 60;

function summarize(batches: ReturnType<typeof buildBatches>) {
  return batches.map((batch) => ({
    members: batch.items.map((item) => item.submarineId),
    anchor: batch.anchorReturnAt,
    notifyAt: batch.notifyAt,
  }));
}

describe('批次合并：锚点固定、非链式', () => {
  it('示例 1：U1=14:20 U2=14:29 U3=14:38，窗口 10 分钟 → A=U1+U2，B=U3', () => {
    const batches = buildBatches(
      [
        { submarineId: 'U1', returnAt: at(14, 20) },
        { submarineId: 'U2', returnAt: at(14, 29) },
        { submarineId: 'U3', returnAt: at(14, 38) },
      ],
      MIN_10,
    );

    expect(summarize(batches)).toEqual([
      { members: ['U1', 'U2'], anchor: at(14, 20), notifyAt: at(14, 29) },
      { members: ['U3'], anchor: at(14, 38), notifyAt: at(14, 38) },
    ]);
  });

  it('示例 2：U1=14:20 U2=14:25 U3=14:29 → 单批次，notify_at = 14:29', () => {
    const batches = buildBatches(
      [
        { submarineId: 'U1', returnAt: at(14, 20) },
        { submarineId: 'U2', returnAt: at(14, 25) },
        { submarineId: 'U3', returnAt: at(14, 29) },
      ],
      MIN_10,
    );

    expect(summarize(batches)).toEqual([
      { members: ['U1', 'U2', 'U3'], anchor: at(14, 20), notifyAt: at(14, 29) },
    ]);
  });

  it('示例 3：U1=14:20 U2=14:31 → 两个批次', () => {
    const batches = buildBatches(
      [
        { submarineId: 'U1', returnAt: at(14, 20) },
        { submarineId: 'U2', returnAt: at(14, 31) },
      ],
      MIN_10,
    );

    expect(summarize(batches)).toEqual([
      { members: ['U1'], anchor: at(14, 20), notifyAt: at(14, 20) },
      { members: ['U2'], anchor: at(14, 31), notifyAt: at(14, 31) },
    ]);
  });

  it('不进行链式合并：14:00/14:09/14:18/14:27 窗口 10 分钟 → 2 个批次', () => {
    const batches = buildBatches(
      [
        { submarineId: 'U1', returnAt: at(14, 0) },
        { submarineId: 'U2', returnAt: at(14, 9) },
        { submarineId: 'U3', returnAt: at(14, 18) },
        { submarineId: 'U4', returnAt: at(14, 27) },
      ],
      MIN_10,
    );

    expect(summarize(batches)).toEqual([
      { members: ['U1', 'U2'], anchor: at(14, 0), notifyAt: at(14, 9) },
      { members: ['U3', 'U4'], anchor: at(14, 18), notifyAt: at(14, 27) },
    ]);
  });

  it('窗口边界为闭区间：差值恰好 10 分钟时合并', () => {
    const batches = buildBatches(
      [
        { submarineId: 'U1', returnAt: at(14, 0) },
        { submarineId: 'U2', returnAt: at(14, 10) },
        { submarineId: 'U3', returnAt: at(14, 10) + 1 },
      ],
      MIN_10,
    );

    expect(summarize(batches)).toEqual([
      { members: ['U1', 'U2'], anchor: at(14, 0), notifyAt: at(14, 10) },
      { members: ['U3'], anchor: at(14, 10) + 1, notifyAt: at(14, 10) + 1 },
    ]);
  });

  it('窗口为 0 时仅合并返航时间完全相同的事件', () => {
    const batches = buildBatches(
      [
        { submarineId: 'U1', returnAt: at(14, 0) },
        { submarineId: 'U2', returnAt: at(14, 0) },
        { submarineId: 'U3', returnAt: at(14, 1) },
      ],
      0,
    );

    expect(summarize(batches)).toEqual([
      { members: ['U1', 'U2'], anchor: at(14, 0), notifyAt: at(14, 0) },
      { members: ['U3'], anchor: at(14, 1), notifyAt: at(14, 1) },
    ]);
  });

  it('输入顺序不影响结果（按 returnAt 排序）', () => {
    const shuffled = buildBatches(
      [
        { submarineId: 'U3', returnAt: at(14, 38) },
        { submarineId: 'U1', returnAt: at(14, 20) },
        { submarineId: 'U2', returnAt: at(14, 29) },
      ],
      MIN_10,
    );

    expect(summarize(shuffled)).toEqual([
      { members: ['U1', 'U2'], anchor: at(14, 20), notifyAt: at(14, 29) },
      { members: ['U3'], anchor: at(14, 38), notifyAt: at(14, 38) },
    ]);
  });

  it('空输入返回空数组', () => {
    expect(buildBatches([], MIN_10)).toEqual([]);
  });

  it('负窗口被拒绝', () => {
    expect(() => buildBatches([], -1)).toThrow(RangeError);
  });
});

describe('提前通知时间', () => {
  it('基于批次最晚返航时间计算', () => {
    expect(computeAdvanceNotifyAt(at(14, 29), 5)).toBe(at(14, 24));
    expect(computeAdvanceNotifyAt(at(14, 29), 10)).toBe(at(14, 19));
    expect(computeAdvanceNotifyAt(at(14, 29), 1)).toBe(at(14, 28));
  });

  it('0 分钟表示不发送提前通知', () => {
    expect(computeAdvanceNotifyAt(at(14, 29), 0)).toBeNull();
  });
});
