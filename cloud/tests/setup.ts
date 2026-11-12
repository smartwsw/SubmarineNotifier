import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

// 每个测试文件独立的内存 D1；在首次使用前应用迁移
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const TABLES = [
  'notification_logs',
  'notification_batch_items',
  'notification_batches',
  'submarines',
  'user_settings',
  'sync_dedup',
  'rate_limits',
  'api_tokens',
  'devices',
  'users',
];

beforeEach(async () => {
  // 清空业务表，保持测试隔离（migrations 表保留）
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
});
