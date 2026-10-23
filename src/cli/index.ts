import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getMigrationStatus, runMigrations } from "../db/migrate.js";
import { closeDatabase, pool } from "../db/pool.js";
import {
  createDatabaseBackup,
  listDatabaseBackups,
  restoreDatabaseBackup,
  verifyBackupIntegrity,
} from "../services/backup.service.js";
import {
  applyProjectMigration,
  executeProjectSql,
  inspectProjectSchema,
} from "../services/database.service.js";
import {
  deployServerFunction,
  invokeServerFunction,
} from "../services/functions-jobs.service.js";
import {
  createProject,
  deleteProject,
  getProjectByRef,
  getProjectDiagnostics,
  listApiKeys,
  listProjectsForUser,
  listProjectSecrets,
  rotateProjectApiKey,
  upsertProjectSecret,
} from "../services/project.service.js";

export async function runCli(argv: string[]): Promise<{
  exitCode: number;
  output: unknown;
}> {
  const [group, subcommand, ...rest] = argv;

  if (!group || group === "help" || group === "--help" || group === "-h") {
    return {
      exitCode: 0,
      output: {
        cli: "maary-base",
        commands: [
          "status | health",
          "db migrate | db status",
          "projects list | projects create <name> [slug] | projects inspect <slug> | projects delete <slug> --confirm <slug>",
          "sql <projectSlug> <query> [--allow-destructive]",
          "migrations apply <projectSlug> <version> <name> <upSql> [downSql]",
          "keys list <projectSlug> | keys rotate <projectSlug> <keyId>",
          "secrets set <projectSlug> <NAME> <VALUE> | secrets list <projectSlug>",
          "functions deploy <projectSlug> <fnSlug> <codeOrFile> | functions invoke <projectSlug> <fnSlug> [jsonBody]",
          "backup create [projectSlug] | backup list [projectSlug] | backup verify <backupId> | backup restore <backupId>",
        ],
      },
    };
  }

  await runMigrations({ silent: true });

  if (group === "status" || group === "health") {
    const mig = await getMigrationStatus();
    const stats = pool.getStats();
    const projects = await listProjectsForUser(null);
    return {
      exitCode: 0,
      output: {
        status: "healthy",
        database: stats,
        migrations: {
          applied: mig.applied.length,
          pending: mig.pending.length,
        },
        projectsCount: projects.length,
      },
    };
  }

  if (group === "db") {
    if (subcommand === "migrate") {
      const applied = await runMigrations({ silent: true });
      return { exitCode: 0, output: { applied } };
    }
    if (subcommand === "status") {
      const status = await getMigrationStatus();
      return { exitCode: 0, output: status };
    }
  }

  if (group === "projects") {
    if (subcommand === "list") {
      const projects = await listProjectsForUser(null);
      return { exitCode: 0, output: { projects } };
    }
    if (subcommand === "create") {
      const name = rest[0];
      const slug = rest[1];
      if (!name) {
        throw new Error("Usage: projects create <name> [slug]");
      }
      const created = await createProject({ name, slug });
      return { exitCode: 0, output: created };
    }
    if (subcommand === "inspect") {
      const ref = rest[0];
      if (!ref) throw new Error("Usage: projects inspect <slug>");
      const project = await getProjectByRef(ref);
      const diag = await getProjectDiagnostics(project);
      const tables = await inspectProjectSchema(project);
      return {
        exitCode: 0,
        output: { ...diag, tables: tables.map((t) => t.name) },
      };
    }
    if (subcommand === "delete") {
      const ref = rest[0];
      const confirmIdx = rest.indexOf("--confirm");
      const confirmSlug = confirmIdx >= 0 ? rest[confirmIdx + 1] : rest[1];
      if (!ref || !confirmSlug) {
        throw new Error("Usage: projects delete <slug> --confirm <slug>");
      }
      await deleteProject(ref, confirmSlug);
      return { exitCode: 0, output: { deleted: true, slug: ref } };
    }
  }

  if (group === "sql") {
    const projectRef = subcommand;
    const sqlQuery = rest[0];
    const allowDestructive = rest.includes("--allow-destructive");
    if (!projectRef || !sqlQuery) {
      throw new Error("Usage: sql <projectSlug> <query> [--allow-destructive]");
    }
    const project = await getProjectByRef(projectRef);
    const res = await executeProjectSql(project, {
      sql: sqlQuery,
      allowDestructive,
      rlsContext: { role: "service_role" },
    });
    return { exitCode: 0, output: res };
  }

  if (group === "migrations" && subcommand === "apply") {
    const [projectRef, version, name, upSql, downSql] = rest;
    if (!projectRef || !version || !name || !upSql) {
      throw new Error(
        "Usage: migrations apply <projectSlug> <version> <name> <upSql> [downSql]"
      );
    }
    const project = await getProjectByRef(projectRef);
    const mig = await applyProjectMigration(project, {
      version,
      name,
      upSql,
      downSql,
    });
    return { exitCode: 0, output: { migration: mig } };
  }

  if (group === "keys") {
    const projectRef = rest[0];
    if (!projectRef) throw new Error("Usage: keys <list|rotate> <projectSlug>");
    const project = await getProjectByRef(projectRef);
    if (subcommand === "list") {
      const keys = await listApiKeys(project.id, true);
      return { exitCode: 0, output: { apiKeys: keys } };
    }
    if (subcommand === "rotate") {
      const keyId = rest[1];
      if (!keyId) throw new Error("Usage: keys rotate <projectSlug> <keyId>");
      const rotated = await rotateProjectApiKey(project.id, keyId);
      return { exitCode: 0, output: { apiKey: rotated } };
    }
  }

  if (group === "secrets") {
    const projectRef = rest[0];
    if (!projectRef) {
      throw new Error("Usage: secrets <list|set> <projectSlug>");
    }
    const project = await getProjectByRef(projectRef);
    if (subcommand === "list") {
      const secrets = await listProjectSecrets(project.id, { reveal: false });
      return { exitCode: 0, output: { secrets } };
    }
    if (subcommand === "set") {
      const name = rest[1];
      const value = rest[2];
      if (!name || value === undefined) {
        throw new Error("Usage: secrets set <projectSlug> <NAME> <VALUE>");
      }
      const secret = await upsertProjectSecret(project.id, { name, value });
      return { exitCode: 0, output: { secret } };
    }
  }

  if (group === "functions") {
    const [projectRef, fnSlug, arg3] = rest;
    if (!projectRef || !fnSlug) {
      throw new Error(
        "Usage: functions <deploy|invoke> <projectSlug> <fnSlug>"
      );
    }
    const project = await getProjectByRef(projectRef);
    if (subcommand === "deploy") {
      if (!arg3) {
        throw new Error(
          "Usage: functions deploy <projectSlug> <fnSlug> <codeOrFile>"
        );
      }
      let code = arg3;
      if (arg3.endsWith(".js") || arg3.endsWith(".ts")) {
        code = await readFile(arg3, "utf8");
      }
      const deployed = await deployServerFunction(project, {
        slug: fnSlug,
        code,
        verifyJwt: false,
      });
      return { exitCode: 0, output: { function: deployed } };
    }
    if (subcommand === "invoke") {
      const body = arg3 ? JSON.parse(arg3) : {};
      const res = await invokeServerFunction(
        project,
        fnSlug,
        { method: "POST", body },
        { role: "service_role" },
        { hasValidCredentials: true }
      );
      return { exitCode: 0, output: res };
    }
  }

  if (group === "backup") {
    if (subcommand === "create") {
      const projectRef = rest[0];
      const project = projectRef ? await getProjectByRef(projectRef) : null;
      const backup = await createDatabaseBackup({
        projectId: project?.id,
      });
      return { exitCode: 0, output: { backup } };
    }
    if (subcommand === "list") {
      const projectRef = rest[0];
      const project = projectRef ? await getProjectByRef(projectRef) : null;
      const backups = await listDatabaseBackups(project?.id);
      return { exitCode: 0, output: { backups } };
    }
    if (subcommand === "verify") {
      const backupId = rest[0];
      if (!backupId) throw new Error("Usage: backup verify <backupId>");
      const res = await verifyBackupIntegrity(backupId);
      return { exitCode: 0, output: res };
    }
    if (subcommand === "restore") {
      const backupId = rest[0];
      if (!backupId) throw new Error("Usage: backup restore <backupId>");
      const res = await restoreDatabaseBackup(backupId);
      return { exitCode: 0, output: res };
    }
  }

  throw new Error(`Unknown CLI command '${group} ${subcommand ?? ""}'.`);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url).endsWith(
    process.argv[1].replace(/^.*[/\\]/, "")
  );

if (isMain) {
  runCli(process.argv.slice(2))
    .then(async (res) => {
      console.log(JSON.stringify(res.output, null, 2));
      await closeDatabase();
      process.exitCode = res.exitCode;
    })
    .catch(async (err) => {
      console.error("CLI Error:", err?.message ?? err);
      await closeDatabase();
      process.exitCode = 1;
    });
}
