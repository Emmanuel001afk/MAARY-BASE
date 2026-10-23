import type { FastifyInstance } from "fastify";
export async function registerPlatformRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/platform", async () => ({
    name: "MAARY BASE",
    version: "0.2.0",
    status: "early-access-control-plane",
    database: { engine: "PostgreSQL", configured: true },
    modules: {
      controlPlane: "implemented",
      projectLifecycle: "implemented-schema-isolated",
      authentication: "implemented-password-and-rotating-refresh-sessions",
      projectMembershipAuthorization: "implemented-membership-management-and-role-checks",
      scopedApiKeys: "implemented",
      databaseApi: "planned",
      rowLevelSecurity: "planned",
      emailVerificationAndRecovery: "planned",
      objectStorage: "planned",
      realtime: "planned",
      serverFunctions: "planned",
      backgroundJobs: "planned",
      administrationDashboard: "planned",
      backupsAndRestore: "planned",
      multiNodeReplication: "planned",
    },
  }));
}
