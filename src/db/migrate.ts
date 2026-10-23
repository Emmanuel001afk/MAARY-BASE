import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { pool } from "./pool.js";

async function resolveMigrationsDir(): Promise<string> {
  const localDir = fileURLToPath(new URL("./migrations/", import.meta.url));
  try {
    await access(localDir);
    return localDir;
  } catch {
    return join(process.cwd(), "src", "db", "migrations");
  }
}

export async function runMigrations(
  options: { silent?: boolean } = {}
): Promise<string[]> {
  const directory = await resolveMigrationsDir();
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!config.DATABASE_URL.startsWith("pglite://") && config.DATABASE_URL !== "memory://") {
      await client.query("SELECT pg_advisory_xact_lock(1346458194, 1)");
    }
    await client.query(
      "CREATE TABLE IF NOT EXISTS platform_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    );
    for (const file of files) {
      const exists = await client.query(
        "SELECT 1 FROM platform_migrations WHERE name = $1",
        [file]
      );
      if (exists.rowCount) continue;
      const sql = await readFile(join(directory, file), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO platform_migrations (name) VALUES ($1)", [
        file,
      ]);
      applied.push(file);
      if (!options.silent) {
        console.log("Applied migration:", file);
      }
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getMigrationStatus(): Promise<{
  applied: Array<{ name: string; applied_at: string }>;
  pending: string[];
}> {
  const directory = await resolveMigrationsDir();
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  await pool.query(
    "CREATE TABLE IF NOT EXISTS platform_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
  );
  const res = await pool.query<{ name: string; applied_at: string }>(
    "SELECT name, applied_at FROM platform_migrations ORDER BY name ASC"
  );
  const appliedSet = new Set(res.rows.map((r) => r.name));
  const pending = files.filter((f) => !appliedSet.has(f));
  return { applied: res.rows, pending };
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url).endsWith(
    process.argv[1].replace(/^.*[/\\]/, "")
  );

if (isMain) {
  runMigrations()
    .then(async () => {
      await pool.end();
    })
    .catch(async (error) => {
      console.error("Database migration failed", error);
      await pool.end();
      process.exitCode = 1;
    });
}
