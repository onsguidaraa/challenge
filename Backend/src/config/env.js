import 'dotenv/config';
import { z } from 'zod';

const duration = z
  .string()
  .regex(/^\d+[smhd]$/, 'must be a number followed by s, m, h or d (e.g. 15m, 7d)');

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    MONGODB_URI: z
      .string()
      .min(1, 'is required')
      .refine(
        (v) => /^mongodb(\+srv)?:\/\//.test(v),
        'must start with mongodb:// or mongodb+srv://',
      ),
    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),
    ACCESS_TOKEN_TTL: duration.default('15m'),
    REFRESH_TOKEN_TTL: duration.default('7d'),
    // Minimum time between two automatic learnedStats recomputations per user. 0 disables it.
    LEARNED_STATS_MIN_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(300),
    CORS_ORIGIN: z
      .string()
      .min(1, 'is required')
      .transform((v) =>
        v
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      )
      .refine((list) => list.length > 0, 'must contain at least one origin'),
  })
  .refine((env) => env.JWT_ACCESS_SECRET !== env.JWT_REFRESH_SECRET, {
    path: ['JWT_REFRESH_SECRET'],
    message: 'must be different from JWT_ACCESS_SECRET',
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`);
  console.error(`Invalid environment configuration:\n${lines.join('\n')}`);
  process.exit(1);
}

export const env = Object.freeze({
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
});
