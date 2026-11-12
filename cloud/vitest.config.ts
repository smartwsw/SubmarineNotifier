import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// 迁移在 Node 侧读取，测试内通过 applyD1Migrations 应用到本地 D1
const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      main: './src/index.ts',
      miniflare: {
        bindings: {
          // 测试专用固定密钥（非生产值）
          SECRETS_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
          ENVIRONMENT: 'dev',
          DEV_INSECURE_PUSH_HOSTS: 'localhost,127.0.0.1',
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
});
