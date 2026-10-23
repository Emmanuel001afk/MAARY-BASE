import pg from "pg";
import { config } from "../config.js";
const { Pool } = pg;
export const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, application_name: "maary-base-api" });
pool.on("error", error => console.error("Unexpected idle PostgreSQL client error", error));
export async function closeDatabase(): Promise<void> { await pool.end(); }
