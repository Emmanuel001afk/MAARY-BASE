import type { FastifyInstance } from "fastify";
export async function registerPlatformRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/platform", async () => ({ name: "MAARY BASE", version: "0.1.0", status: "foundation", database: { engine: "PostgreSQL", status: "configured" }, modules: { databaseApi: "foundation", authentication: "planned", projectIsolation: "planned", objectStorage: "planned", realtime: "planned", serverFunctions: "planned", backgroundJobs: "planned", administrationDashboard: "planned", multiNodeReplication: "planned" } }));
}
