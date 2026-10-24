import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeDatabase } from "./db/pool.js";
import { getApkStatus } from "./services/apk.service.js";

const app = await buildApp();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down MARRY BASE");
  try {
    await app.close();
    await closeDatabase();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, "Graceful shutdown failed");
    process.exit(1);
  }
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  const apk = await getApkStatus();
  app.log.info(
    {
      platform: "MARRY BASE",
      apkState: apk.state,
      apkFile: apk.artifact.filePath,
      apkSha256: apk.artifact.checksumSha256,
      gradleBuildPossible: apk.buildEnvironment.gradleBuildPossible,
    },
    apk.state === "available"
      ? "MARRY BASE Android artifact verified"
      : "MARRY BASE Android artifact is not present; the API reports this instead of fabricating one"
  );
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error({ err: error }, "Server failed to start");
  await closeDatabase();
  process.exit(1);
}
