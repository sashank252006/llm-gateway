import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ADMIN_TOKEN: z.string().min(16),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  LOG_PROMPTS: z.coerce.boolean().default(false),
  ROUTE_CONFIG_PATH: z.string().default('./config/routing.yaml'),
  PRICES_CONFIG_PATH: z.string().default('./config/prices.yaml'),
  USAGE_QUEUE_MAX: z.coerce.number().default(10000),
  USAGE_FLUSH_INTERVAL_MS: z.coerce.number().default(1000),
  USAGE_FLUSH_BATCH_SIZE: z.coerce.number().default(100),
  AUTH_LRU_TTL_MS: z.coerce.number().default(60000),
  AUTH_LRU_MAX: z.coerce.number().default(1000),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().default(50),
  CACHE_TTL_SECONDS: z.coerce.number().default(86400),
  BREAKER_FAILURE_THRESHOLD: z.coerce.number().default(5),
  BREAKER_COOLDOWN_MS: z.coerce.number().default(30000),
  REQUEST_OVERALL_DEADLINE_MS: z.coerce.number().default(60000),
  RETRY_MAX_ATTEMPTS: z.coerce.number().default(2),
  BODY_LIMIT: z.string().default('1mb'),
});

const result = EnvSchema.safeParse(process.env);
if (!result.success) {
  console.error('Invalid environment configuration:');
  console.error(JSON.stringify(result.error.flatten(), null, 2));
  process.exit(1);
}

export const env = result.data;
export type Env = typeof env;
