import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeDatabase } from "./db/pool.js";
import { getOrBuildDefaultApk } from "./services/apk.service.js";

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
  const { info: apkInfo } = await getOrBuildDefaultApk();
  app.log.info(
    {
      platform: "MARRY BASE",
      apkFile: apkInfo.filePath,
      apkSha256: apkInfo.checksumSha256,
    },
    "MARRY BASE Android APK initialized and verified"
  );
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error({ err: error }, "Server failed to start");
  await closeDatabase();
  process.exit(1);
}
