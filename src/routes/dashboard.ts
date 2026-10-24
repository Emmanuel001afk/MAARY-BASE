import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

const DASHBOARD_DIR = resolve(process.cwd(), "public", "dashboard");
const MOBILE_DIR = resolve(process.cwd(), "public", "mobile");

const DASHBOARD_ASSETS = {
  "/dashboard/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/dashboard/app.js": { file: "app.js", type: "application/javascript; charset=utf-8" },
  "/dashboard/js/core.js": { file: "js/core.js", type: "application/javascript; charset=utf-8" },
  "/dashboard/js/pages.js": { file: "js/pages.js", type: "application/javascript; charset=utf-8" },
  "/dashboard/js/actions.js": { file: "js/actions.js", type: "application/javascript; charset=utf-8" },
} as const;

async function sendDashboardAsset(
  reply: FastifyReply,
  file: string,
  contentType: string,
  cacheControl = "no-cache"
) {
  const contents = await readFile(resolve(DASHBOARD_DIR, file));
  return reply
    .header("content-type", contentType)
    .header("cache-control", cacheControl)
    .send(contents);
}

export async function registerDashboardRoutes(
  app: FastifyInstance
): Promise<void> {
  const serveIndex = async (_request: unknown, reply: FastifyReply) =>
    sendDashboardAsset(reply, "index.html", "text/html; charset=utf-8");

  app.get("/", serveIndex);
  app.get("/dashboard", serveIndex);

  for (const [route, asset] of Object.entries(DASHBOARD_ASSETS)) {
    app.get(route, async (_request, reply) =>
      sendDashboardAsset(reply, asset.file, asset.type)
    );
  }

  // The mobile connection hub is also usable in a mobile browser. The Android
  // app has its own native equivalent; both validate /ready before proceeding.
  const mobileAssets = {
    "/mobile/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/mobile/app.js": { file: "app.js", type: "application/javascript; charset=utf-8" },
    "/mobile/config.js": { file: "config.js", type: "application/javascript; charset=utf-8" },
    "/mobile/app-icon.png": { file: "app-icon.png", type: "image/png" },
  } as const;

  const serveMobileIndex = async (_request: unknown, reply: FastifyReply) => {
    const contents = await readFile(resolve(MOBILE_DIR, "index.html"));
    return reply.header("content-type", "text/html; charset=utf-8").send(contents);
  };
  app.get("/mobile", serveMobileIndex);
  app.get("/mobile/", serveMobileIndex);
  for (const [route, asset] of Object.entries(mobileAssets)) {
    app.get(route, async (_request, reply) => {
      const contents = await readFile(resolve(MOBILE_DIR, asset.file));
      return reply.header("content-type", asset.type).send(contents);
    });
  }

  app.get("/dashboard/logo.png", async (_request, reply) => {
    const buf = await readFile(resolve(process.cwd(), "assets", "logo.png"));
    return reply
      .header("content-type", "image/png")
      .header("cache-control", "public, max-age=86400")
      .send(buf);
  });

  app.get("/dashboard/logo.svg", async (_request, reply) => {
    const buf = await readFile(resolve(process.cwd(), "assets", "logo.svg"));
    return reply
      .header("content-type", "image/svg+xml")
      .header("cache-control", "public, max-age=86400")
      .send(buf);
  });
}
