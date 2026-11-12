import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      SCHEDULER: DurableObjectNamespace;
      SECRETS_KEY: string;
      ENVIRONMENT: string;
      DEV_INSECURE_PUSH_HOSTS?: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
