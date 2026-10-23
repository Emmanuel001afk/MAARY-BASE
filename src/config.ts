import "dotenv/config";
import { z } from "zod";
const schema = z.object({ NODE_ENV: z.enum(["development","test","production"]).default("development"), HOST: z.string().default("127.0.0.1"), PORT: z.coerce.number().int().min(1).max(65535).default(4100), LOG_LEVEL: z.enum(["fatal","error","warn","info","debug","trace","silent"]).default("info"), DATABASE_URL: z.string().min(1), CORS_ORIGIN: z.string().default("http://localhost:3000") });
const parsed = schema.safeParse(process.env);
if (!parsed.success) throw new Error("Invalid configuration: " + parsed.error.issues.map(i => i.path.join(".") + ": " + i.message).join("; "));
export const config = parsed.data;
