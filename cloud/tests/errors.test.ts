import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, register } from './helpers.js';

describe('错误响应不泄露内部细节', () => {
  it('未知路由返回结构化 404，不含路径以外的内部信息', async () => {
    const user = await register('404 测试');
    const { status, body } = await api('/does/not/exist', { token: user.token });

    expect(status).toBe(404);
    expect(body.error?.code).toBe('NOT_FOUND');
    expect(body.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('at ');
  });

  it('未认证访问未知路由返回 401 而非 404', async () => {
    const { status } = await api('/does/not/exist');
    expect(status).toBe(401);
  });

  it('内部异常返回 500 + INTERNAL_ERROR，不含堆栈', async () => {
    const user = await register('500 测试');
    // 破坏表以触发未捕获异常（本文件的 D1 实例独立于其他测试文件）
    await env.DB.prepare('DROP TABLE submarines').run();

    const { status, body } = await api('/submarines', { token: user.token });

    expect(status).toBe(500);
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(body.error?.message).toBe('Internal server error');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('no such table');
    expect(serialized).not.toContain('submarines');
    expect(serialized).not.toContain('.ts:');
  });
});
