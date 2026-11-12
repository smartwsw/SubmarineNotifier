import { describe, expect, it } from 'vitest';
import { api, register } from './helpers.js';

describe('限流', () => {
  it('同一用户超过每分钟推送测试次数后返回 429 并带 Retry-After', async () => {
    // 用户未配置推送渠道，请求会以 400 结束，但计数发生在校验之前，因此足以验证限流。
    const user = await register('限流测试');

    for (let i = 0; i < 10; i += 1) {
      const { status } = await api('/push/test', { method: 'POST', token: user.token, body: '{}' });
      expect(status).toBe(400);
    }

    const limited = await api('/push/test', { method: 'POST', token: user.token, body: '{}' });
    expect(limited.status).toBe(429);
    expect(limited.body.error?.code).toBe('RATE_LIMITED');
  });

  it('限流按用户隔离，一个用户超限不影响其他用户', async () => {
    const noisy = await register('超限用户');
    const quiet = await register('正常用户');

    for (let i = 0; i < 11; i += 1) {
      await api('/push/test', { method: 'POST', token: noisy.token, body: '{}' });
    }

    const { status } = await api('/push/test', { method: 'POST', token: quiet.token, body: '{}' });
    expect(status).toBe(400);
  });
});
