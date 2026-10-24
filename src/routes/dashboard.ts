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

const MOBILE_ASSETS = {
  "/mobile/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/mobile/app.js": { file: "app.js", type: "application/javascript; charset=utf-8" },
  "/mobile/config.js": { file: "config.js", type: "application/javascript; charset=utf-8" },
  "/mobile/app-icon.png": { file: "app-icon.png", type: "image/png" },
} as const;

async function sendAssetFromDir(
  dir: string,
  reply: FastifyReply,
  file: string,
  contentType: string,
  cacheControl = "no-cache"
) {
  const contents = await readFile(resolve(dir, file));
  return reply
    .header("content-type", contentType)
    .header("cache-control", cacheControl)
    .send(contents);
}

export async function registerDashboardRoutes(
  app: FastifyInstance
): Promise<void> {
  const serveIndex = async (_request: unknown, reply: FastifyReply) =>
    sendAssetFromDir(DASHBOARD_DIR, reply, "index.html", "text/html; charset=utf-8");

  app.get("/", serveIndex);
  app.get("/dashboard", serveIndex);
  app.get("/dashboard/", serveIndex);
  app.get("/dashboard/index.html", serveIndex);

  for (const [route, asset] of Object.entries(DASHBOARD_ASSETS)) {
    app.get(route, async (_request, reply) =>
      sendAssetFromDir(DASHBOARD_DIR, reply, asset.file, asset.type)
    );
  }

  const serveMobileIndex = async (_request: unknown, reply: FastifyReply) =>
    sendAssetFromDir(MOBILE_DIR, reply, "index.html", "text/html; charset=utf-8");

  app.get("/mobile", async (_request, reply) => reply.redirect("/mobile/"));
  app.get("/mobile/", serveMobileIndex);
  app.get("/mobile/index.html", serveMobileIndex);

  for (const [route, asset] of Object.entries(MOBILE_ASSETS)) {
    app.get(route, async (_request, reply) =>
      sendAssetFromDir(MOBILE_DIR, reply, asset.file, asset.type)
    );
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
