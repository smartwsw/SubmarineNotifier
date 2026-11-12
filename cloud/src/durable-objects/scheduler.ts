import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../index.js';
import { Repository } from '../storage/repository.js';
import { deliveryEnv, processBatch, replanUser } from '../services/delivery-service.js';
import { nextAlarmTime } from '../services/scheduler-service.js';

interface SchedulerState {
  lastAlarmAt: number;
  lastRunResult: string;
}

/**
 * 每个用户一个 Scheduler DO：
 *  - 所有排程状态持久化在 D1（批次）+ DO storage（运行元信息）；
 *  - 仅使用 setAlarm() 驱动，不使用 setTimeout/setInterval；
 *  - 每次 alarm 处理所有到期动作，并按需安排下一次；
 *  - 无待处理任务时清除 alarm。
 */
export class SchedulerDurableObject extends DurableObject<Env> {
  private get repo(): Repository {
    return new Repository(this.env.DB);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/init':
        return this.handleInit(request);
      case '/replan':
        return this.handleReplan();
      case '/delete':
        return this.handleDelete();
      case '/status':
        return this.handleStatus();
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private async handleInit(request: Request): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return Response.json({ ok: false, error: 'missing_user_id' }, { status: 400 });
    const existing = await this.ctx.storage.get<string>('userId');
    if (existing && existing !== userId) {
      return Response.json({ ok: false, error: 'user_mismatch' }, { status: 409 });
    }
    await this.ctx.storage.put('userId', userId);
    return Response.json({ ok: true });
  }

  private async handleReplan(): Promise<Response> {
    const userId = await this.ctx.storage.get<string>('userId');
    if (!userId) return Response.json({ ok: false, error: 'userId_not_initialized' }, { status: 409 });

    const now = Math.floor(Date.now() / 1000);
    const settings = await this.repo.getSettings(userId);
    await replanUser(deliveryEnv(this.env, this.repo), userId, settings, now);
    const next = await this.scheduleNext(now);
    return Response.json({ ok: true, nextAlarmAt: next });
  }

  private async handleDelete(): Promise<Response> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    return Response.json({ ok: true });
  }

  private async handleStatus(): Promise<Response> {
    const userId = await this.ctx.storage.get<string>('userId');
    if (!userId) return Response.json({ ok: true, initialized: false });
    const state = await this.ctx.storage.get<SchedulerState>('state');
    const batches = await this.repo.listPendingBatches(userId);
    return Response.json({
      ok: true,
      initialized: true,
      pendingBatches: batches.length,
      nextAlarmAt: await this.ctx.storage.getAlarm(),
      state: state ?? null,
    });
  }

  private async ensureUserId(): Promise<string | null> {
    // userId 由 /init 写入；idFromName 保证同一用户始终路由到同一实例
    return (await this.ctx.storage.get<string>('userId')) ?? null;
  }

  /** 计算并设置下一次 alarm；无任务时清除 */
  private async scheduleNext(now: number): Promise<number | null> {
    const userId = await this.ensureUserId();
    if (!userId) return null;

    const batches = await this.repo.listPendingBatches(userId);
    const next = nextAlarmTime(batches);
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return null;
    }
    // Alarm 时间必须晚于当前时间；已过期任务立即执行
    await this.ctx.storage.setAlarm(Math.max(next, now + 1) * 1000);
    return next;
  }

  override async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get<string>('userId');
    if (!stored) return;

    const userId = stored;
    const now = Math.floor(Date.now() / 1000);
    const settings = await this.repo.getSettings(userId);
    const batches = await this.repo.listPendingBatches(userId);

    const results: string[] = [];
    for (const batch of batches) {
      try {
        const outcome = await processBatch(deliveryEnv(this.env, this.repo), userId, batch, settings, now);
        results.push(`${batch.id}:${outcome.sent ? 'sent' : outcome.advanced ? 'advance' : outcome.skippedReason ?? 'noop'}`);
      } catch (error) {
        results.push(`${batch.id}:error:${(error as Error).message.slice(0, 100)}`);
      }
    }

    await this.ctx.storage.put<SchedulerState>('state', {
      lastAlarmAt: now,
      lastRunResult: results.join(','),
    });

    await this.scheduleNext(now);

    // 顺带清理过期数据（每小时最多一次）
    const lastCleanup = (await this.ctx.storage.get<number>('lastCleanup')) ?? 0;
    if (now - lastCleanup > 3600) {
      await this.repo.cleanup(now);
      await this.ctx.storage.put('lastCleanup', now);
    }
  }
}

/** 确保 DO 已写入 userId（首次由 Worker 调用） */
export async function ensureScheduler(stub: DurableObjectStub, userId: string): Promise<void> {
  await stub.fetch('https://scheduler/init', {
    method: 'POST',
    headers: { 'X-User-Id': userId },
  });
}
