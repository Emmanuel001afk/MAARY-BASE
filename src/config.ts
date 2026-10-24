import "dotenv/config";
import { z } from "zod";
import { join } from "node:path";

const isTestRunner =
  process.env.NODE_ENV === "test" ||
  Boolean(process.env.NODE_TEST_CONTEXT) ||
  process.argv.some((arg) => arg === "--test" || arg.endsWith(".test.ts"));

const defaultNodeEnv = isTestRunner ? "test" : "development";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default(defaultNodeEnv),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default(isTestRunner ? "silent" : "info"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default(isTestRunner ? "pglite://memory" : "pglite://./data/postgres"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(300_000)
    .default(15_000),
  MAX_QUERY_ROWS: z.coerce.number().int().min(1).max(50_000).default(1_000),
  CORS_ORIGIN: z.string().default("*"),
  JWT_SECRET: z
    .string()
    .min(32)
    .default("maary-base-dev-jwt-secret-change-in-production-0123456789"),
  PLATFORM_BOOTSTRAP_TOKEN: z
    .string()
    .min(32)
    .default("maary-base-dev-bootstrap-token-change-in-production-0123456789"),
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  ENCRYPTION_KEY: z
    .string()
    .min(16)
    .default("maary-base-dev-encryption-master-key-change-in-prod-32b"),
  APK_SIGNING_PRIVATE_KEY: z.string().optional(),
  APK_SIGNING_KEY_FILE: z
    .string()
    .default(
      join(
        process.cwd(),
        isTestRunner
          ? "data/test-apk-signing/private-key.pem"
          : "data/apk-signing/private-key.pem"
      )
    ),
  STORAGE_BACKEND: z.enum(["local", "s3"]).default("local"),
  STORAGE_DIR: z
    .string()
    .default(
      join(process.cwd(), isTestRunner ? "data/test-storage" : "storage")
    ),
  BACKUP_DIR: z
    .string()
    .default(
      join(process.cwd(), isTestRunner ? "data/test-backups" : "data/backups")
    ),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(52_428_800),
  FUNCTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  WORKER_ENABLED: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined ? !isTestRunner : v !== "false" && v !== "0"
    ),
  WORKER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(60_000)
    .default(1_000),
  AUTO_MIGRATE: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? true : v !== "false" && v !== "0")),
  RATE_LIMIT_MAX: z.coerce.number().int().min(10).default(1_000),
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(
    "Invalid configuration: " +
      parsed.error.issues
        .map((i) => i.path.join(".") + ": " + i.message)
        .join("; ")
  );
}

if (parsed.data.NODE_ENV === "production") {
  if (parsed.data.JWT_SECRET.includes("maary-base-dev-jwt-secret")) {
    throw new Error(
      "Unsafe configuration: JWT_SECRET must be explicitly set in production."
    );
  }
  if (parsed.data.ENCRYPTION_KEY.includes("maary-base-dev-encryption-master-key")) {
    throw new Error(
      "Unsafe configuration: ENCRYPTION_KEY must be explicitly set in production."
    );
  }
  if (parsed.data.PLATFORM_BOOTSTRAP_TOKEN.includes("maary-base-dev-bootstrap-token")) {
    throw new Error(
      "Unsafe configuration: PLATFORM_BOOTSTRAP_TOKEN must be explicitly set in production."
    );
  }
}

export const config = parsed.data;
export type AppConfig = typeof config;
