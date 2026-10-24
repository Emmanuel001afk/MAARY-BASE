import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";

async function register(app: Awaited<ReturnType<typeof buildApp>>, label: string) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/platform/auth/register",
    payload: { email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@maary.dev`, password: "StrongPassword123!", name: label },
  });
  assert.equal(response.statusCode, 201, response.body);
  return {
    token: response.json().accessToken as string,
    email: response.json().user.email as string,
    userId: response.json().user.id as string,
  };
}

test("Operational status, logs, roles, connection and API catalogue reflect real state", async () => {
  const app = await buildApp();
  try {
    const operator = await register(app, "ops");
    const auth = { authorization: `Bearer ${operator.token}` };

    const projectRes = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: auth,
      payload: { name: "Operations Project" },
    });
    assert.equal(projectRes.statusCode, 201, projectRes.body);
    const project = projectRes.json().project;
    const serviceKey = projectRes.json().apiKeys.serviceRoleKey as string;

    const tableRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.slug}/database/tables`,
      headers: auth,
      payload: {
        name: "tasks",
        columns: [
          { name: "id", type: "uuid", primaryKey: true, defaultValue: "gen_random_uuid()" },
          { name: "owner_id", type: "uuid" },
          { name: "title", type: "text", notNull: true },
          { name: "created_at", type: "timestamptz", defaultValue: "now()" },
        ],
        enableRls: true,
      },
    });
    assert.equal(tableRes.statusCode, 201, tableRes.body);

    const policyRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.slug}/database/policies`,
      headers: auth,
      payload: {
        tableName: "tasks",
        policyName: "owners_only",
        command: "ALL",
        usingExpression: "owner_id = auth.uid()",
        checkExpression: "owner_id = auth.uid()",
        enableRlsOnTable: true,
      },
    });
    assert.equal(policyRes.statusCode, 201, policyRes.body);

    // --- Project service status
    const statusRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${project.slug}/status`,
      headers: auth,
    });
    assert.equal(statusRes.statusCode, 200, statusRes.body);
    const status = statusRes.json();
    assert.equal(status.project.schemaName, project.schema_name);
    const services = new Map(status.services.map((service: any) => [service.id, service]));
    for (const id of ["database", "rls", "auth", "api", "storage", "functions", "jobs", "realtime", "backups"]) {
      assert.ok(services.has(id), `missing service status for ${id}`);
    }
    assert.equal((services.get("database") as any).state, "operational");
    assert.equal((services.get("rls") as any).state, "operational");
    assert.equal((services.get("api") as any).state, "operational");
    assert.equal((services.get("storage") as any).state, "requires_configuration");
    assert.equal((services.get("backups") as any).state, "requires_configuration");
    // A table alone does not prove delivery: realtime stays unverified until an
    // event is actually captured.
    assert.equal((services.get("realtime") as any).state, "implemented_unverified");
    assert.equal(status.overall, "partially_implemented");
    const rlsChecks = (services.get("rls") as any).checks;
    assert.ok(rlsChecks.some((check: any) => check.name === "policies" && check.value === 1));

    // --- Database roles and policies
    const rolesRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${project.slug}/database/roles`,
      headers: auth,
    });
    assert.equal(rolesRes.statusCode, 200, rolesRes.body);
    const roles = rolesRes.json();
    assert.equal(roles.schemaName, project.schema_name);
    assert.equal(roles.roles.length, 2);
    const privileged = roles.roles.find((role: any) => role.name === project.db_role_name);
    const restricted = roles.roles.find((role: any) => role.name === `${project.db_role_name}_rls`);
    assert.ok(privileged && restricted, "both project database roles must exist");
    // Both roles are deliberately non-superuser and have no BYPASSRLS attribute.
    // service_role is granted access through a per-table internal RLS policy,
    // so bypassRls must remain false for BOTH roles.
    assert.equal(restricted.isSuperuser, false);
    assert.equal(privileged.isSuperuser, false);
    assert.equal(privileged.bypassRls, false);
    assert.equal(restricted.bypassRls, false);
    assert.match(privileged.purpose, /internal per-table policy/);
    assert.match(privileged.bypassMechanism, /no BYPASSRLS/);
    assert.match(restricted.bypassMechanism, /RLS always enforced/);
    // The internal bypass policy is not presented as a user-editable policy.
    assert.ok(roles.policies.every((policy: any) => !policy.name.includes("_marry_base_")));
    assert.ok(privileged.grants.some((grant: any) => grant.table === "tasks"));
    assert.equal(roles.policies.length, 1);
    assert.equal(roles.policies[0].name, "owners_only");
    assert.match(roles.policies[0].using, /auth\.uid\(\)/);
    assert.deepEqual(roles.tablesWithoutRls, []);

    // --- Connection diagnostics never reveal credentials
    const connectionRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${project.slug}/database/connection`,
      headers: auth,
    });
    assert.equal(connectionRes.statusCode, 200, connectionRes.body);
    const connection = connectionRes.json();
    assert.equal(connection.schemaName, project.schema_name);
    assert.equal(connection.engine, "PostgreSQL");
    assert.ok(["external", "embedded-disk", "embedded-memory"].includes(connection.mode));
    assert.equal(typeof connection.statementTimeoutMs, "number");
    assert.ok(Array.isArray(connection.capabilities.extensions));
    assert.ok(!JSON.stringify(connection).toLowerCase().includes("password="));

    // --- API catalogue
    const catalogueRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${project.slug}/api/endpoints`,
      headers: { ...auth, host: "maary.test" },
    });
    assert.equal(catalogueRes.statusCode, 200, catalogueRes.body);
    const catalogue = catalogueRes.json();
    assert.equal(catalogue.baseUrl, "http://maary.test");
    const methods = (table: string) =>
      catalogue.endpoints.filter((endpoint: any) => endpoint.path === `/v1/projects/${project.slug}/rest/${table}`).map((endpoint: any) => endpoint.method);
    assert.deepEqual(methods("tasks").sort(), ["DELETE", "GET", "PATCH", "POST"]);
    assert.ok(catalogue.endpoints.some((endpoint: any) => endpoint.path.endsWith("/auth/login")));
    assert.ok(catalogue.endpoints.some((endpoint: any) => endpoint.path.endsWith("/realtime/ws?apikey=…")));
    const insertExample = catalogue.endpoints.find((endpoint: any) => endpoint.method === "POST" && endpoint.path.endsWith("/rest/tasks"));
    assert.match(insertExample.example, /curl -X POST/);
    assert.match(insertExample.example, new RegExp(project.slug));
    assert.ok(catalogue.notes.some((note: string) => note.includes("Row-Level Security")));

    // --- Logs: audit entries, filters, and validation
    await app.inject({
      method: "POST",
      url: `/v1/projects/${project.slug}/rest/tasks`,
      headers: { apikey: serviceKey, "content-type": "application/json" },
      payload: { title: "Write a test" },
    });
    // The row insert fires the change-capture trigger; realtime may now claim
    // operational because an event is persisted for this project.
    const statusAfterEvent = await app.inject({
      method: "GET",
      url: `/v1/projects/${project.slug}/status`,
      headers: auth,
    });
    const realtimeAfter = statusAfterEvent
      .json()
      .services.find((service: any) => service.id === "realtime");
    assert.equal(realtimeAfter.state, "operational", JSON.stringify(realtimeAfter));
    assert.ok(realtimeAfter.checks.some((check: any) => check.name === "persisted events" && check.value > 0));

    const logsRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${project.slug}/logs?limit=50`,
      headers: auth,
    });
    assert.equal(logsRes.statusCode, 200, logsRes.body);
    const logs = logsRes.json();
    assert.ok(logs.entries.length > 0);
    assert.ok(logs.counts.audit > 0);
    assert.ok(logs.entries.every((entry: any) => typeof entry.timestamp === "string" && entry.source));

    const filtered = await app.inject({
      method: "GET",
      url: `/v1/projects/${project.slug}/logs?source=audit&level=info&limit=5`,
      headers: auth,
    });
    assert.equal(filtered.statusCode, 200);
    assert.ok(filtered.json().entries.length <= 5);
    assert.ok(filtered.json().entries.every((entry: any) => entry.source === "audit" && entry.level === "info"));

    const invalidSource = await app.inject({
      method: "GET",
      url: `/v1/projects/${project.slug}/logs?source=database`,
      headers: auth,
    });
    assert.equal(invalidSource.statusCode, 400);
    assert.match(invalidSource.json().message, /Unknown log source/);

    const invalidLimit = await app.inject({
      method: "GET",
      url: `/v1/projects/${project.slug}/logs?limit=-4`,
      headers: auth,
    });
    assert.equal(invalidLimit.statusCode, 400);

    // --- Platform status is authenticated and derived
    const anonymousPlatform = await app.inject({ method: "GET", url: "/v1/platform/status" });
    assert.equal(anonymousPlatform.statusCode, 401);
    // Deploy and invoke a function so the platform function status has real
    // invocation evidence instead of a hard-coded claim.
    const deploy = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.slug}/functions`,
      headers: auth,
      payload: { slug: "status-probe", name: "Status probe", verifyJwt: false, timeoutMs: 5000, code: "async function handler() { return { statusCode: 200, body: { ok: true } }; }" },
    });
    assert.equal(deploy.statusCode, 201, deploy.body);
    const invoke = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.slug}/functions/status-probe/invoke`,
      headers: auth,
      payload: {},
    });
    assert.equal(invoke.statusCode, 200, invoke.body);

    const platformRes = await app.inject({ method: "GET", url: "/v1/platform/status", headers: auth });
    assert.equal(platformRes.statusCode, 200, platformRes.body);
    const platform = platformRes.json();
    assert.ok(platform.services.length >= 8);
    assert.ok(platform.services.every((service: any) => service.verifiedBy && Array.isArray(service.checks)));
    const databaseService = platform.services.find((service: any) => service.id === "database");
    assert.equal(databaseService.state, "operational");
    const functionService = platform.services.find((service: any) => service.id === "server-functions");
    assert.equal(functionService.state, "operational", JSON.stringify(functionService));
    const platformRealtime = platform.services.find((service: any) => service.id === "realtime");
    assert.equal(platformRealtime.state, "operational", JSON.stringify(platformRealtime));
    // Unconfigured subsystems keep the overall platform honest.
    assert.notEqual(platform.overall, "operational");
    assert.ok(["partially_implemented", "requires_configuration"].includes(platform.overall));
    assert.ok(platform.android.state === "available" || platform.android.state === "missing");
    assert.equal(typeof platform.android.summary, "string");

    const publicPlatform = await app.inject({ method: "GET", url: "/v1/platform" });
    assert.equal(publicPlatform.statusCode, 200);
    assert.equal(publicPlatform.json().name, "MARRY BASE");
    assert.ok(!publicPlatform.body.includes("DATABASE_URL"));

    // --- Isolation: another operator cannot read this project's diagnostics
    const outsider = await register(app, "outsider");
    const outsiderAuth = { authorization: `Bearer ${outsider.token}` };
    for (const path of [
      `/v1/projects/${project.slug}/status`,
      `/v1/projects/${project.slug}/logs`,
      `/v1/projects/${project.slug}/database/roles`,
      `/v1/projects/${project.slug}/database/connection`,
      `/v1/projects/${project.slug}/api/endpoints`,
    ]) {
      const denied = await app.inject({ method: "GET", url: path, headers: outsiderAuth });
      assert.equal(denied.statusCode, 403, `${path} should be forbidden for an outsider`);
    }

    // --- Viewer role can inspect but not mutate
    const viewer = await register(app, "viewer");
    const addViewer = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.slug}/members`,
      headers: auth,
      payload: { email: viewer.email, role: "viewer" },
    });
    assert.equal(addViewer.statusCode, 201, addViewer.body);
    const viewerAuth = { authorization: `Bearer ${viewer.token}` };
    const viewerStatus = await app.inject({ method: "GET", url: `/v1/projects/${project.slug}/status`, headers: viewerAuth });
    assert.equal(viewerStatus.statusCode, 200);
    const viewerWrite = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.slug}/database/tables`,
      headers: viewerAuth,
      payload: { name: "forbidden_table", columns: [{ name: "id", type: "uuid", primaryKey: true }] },
    });
    assert.equal(viewerWrite.statusCode, 403, viewerWrite.body);
  } finally {
    await app.close();
  }
});
