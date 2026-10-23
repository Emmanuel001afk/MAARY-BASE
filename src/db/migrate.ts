import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";
async function migrate() {
 const directory = fileURLToPath(new URL("./migrations/", import.meta.url));
 const files = (await readdir(directory)).filter(file => file.endsWith(".sql")).sort();
 const client = await pool.connect();
 try {
  await client.query("BEGIN");
  await client.query("CREATE TABLE IF NOT EXISTS platform_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const file of files) {
   const exists = await client.query("SELECT 1 FROM platform_migrations WHERE name = $1", [file]);
   if (exists.rowCount) continue;
   await client.query(await readFile(join(directory, file), "utf8"));
   await client.query("INSERT INTO platform_migrations (name) VALUES ($1)", [file]);
   console.log("Applied migration:", file);
  }
  await client.query("COMMIT");
 } catch (error) { await client.query("ROLLBACK"); throw error; }
 finally { client.release(); await pool.end(); }
}
migrate().catch(error => { console.error("Database migration failed", error); process.exitCode = 1; });
