import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeDatabase } from "./db/pool.js";
import { inspectAndroidEnvironment } from "./services/android-artifact.service.js";

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
  const androidStatus = await inspectAndroidEnvironment();
  app.log.info(
    {
      platform: "MARRY BASE",
      androidStatus: androidStatus.status,
      apkAvailable: androidStatus.downloadAvailable,
      apkFile: androidStatus.artifact?.filePath ?? null,
    },
    androidStatus.summary
  );
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error({ err: error }, "Server failed to start");
  await closeDatabase();
  process.exit(1);
}
