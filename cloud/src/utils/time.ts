export const SECOND = 1;
export const MINUTE = 60;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 潜艇最长航程上限（游戏内约 7 天），用于合理性校验 */
export const MAX_VOYAGE_SECONDS = 7 * DAY;

/** 允许的历史偏差：返航时间最多早于当前时刻这么久仍视为有效 */
export const MAX_PAST_OFFSET_SECONDS = 7 * DAY;

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function isValidUnixSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 4102444800; // < 2100-01-01
}

/**
 * 校验客户端上报的返航时间是否合理。
 * 0 表示"无航行"，始终有效。
 */
export function validateReturnAt(returnAt: number, now: number): { valid: boolean; reason?: string } {
  if (returnAt === 0) return { valid: true };
  if (!isValidUnixSeconds(returnAt)) return { valid: false, reason: 'return_at_not_unix_seconds' };
  if (returnAt < now - MAX_PAST_OFFSET_SECONDS) return { valid: false, reason: 'return_at_too_old' };
  if (returnAt > now + MAX_VOYAGE_SECONDS) return { valid: false, reason: 'return_at_too_far_future' };
  return { valid: true };
}

/** 由返航时间推导状态 */
export function deriveState(returnAt: number, now: number): 'docked' | 'sailing' | 'returned' {
  if (returnAt === 0) return 'docked';
  return returnAt > now ? 'sailing' : 'returned';
}

export function formatInTimeZone(epochSeconds: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      hour12: false,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(epochSeconds * 1000));
  } catch {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'UTC',
      hour12: false,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(epochSeconds * 1000));
  }
}

export function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
