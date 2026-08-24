/**
 * EMA browser agent — self-hosted Playwright worker.
 *
 *   npm install
 *   EMA_AGENT_TOKEN=your-token npm start
 *
 * Listens on ws://localhost:7788 and streams live JPEG frames of the active
 * tab to the EMA web app, and executes browser commands it sends back.
 */
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.EMA_AGENT_PORT || 7788);
const TOKEN = process.env.EMA_AGENT_TOKEN || "";
const FPS = Number(process.env.EMA_AGENT_FPS || 3);
const PROFILE_DIR = process.env.EMA_AGENT_PROFILE || "./.ema-profile";

const VIEWPORTS = {
  desktop: { width: 1280, height: 800, mobile: false },
  mobile: { width: 390, height: 844, mobile: true },
};

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

let context = null;
const tabs = new Map(); // id -> { page, viewport }
let activeTabId = null;

async function ensureContext() {
  if (context) return context;
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: VIEWPORTS.desktop,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  return context;
}

async function newTab(url = "about:blank", viewport = "desktop") {
  const ctx = await ensureContext();
  const page = await ctx.newPage();
  const vp = VIEWPORTS[viewport] ?? VIEWPORTS.desktop;
  await page.setViewportSize({ width: vp.width, height: vp.height });
  const id = randomUUID().slice(0, 8);
  tabs.set(id, { page, viewport });
  activeTabId = id;
  if (url && url !== "about:blank") {
    await page.goto(normalizeUrl(url), { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  return await tabInfo(id);
}

function normalizeUrl(input) {
  const value = String(input || "").trim();
  if (!value) return "about:blank";
  if (/^[a-z]+:\/\//i.test(value)) return value;
  if (/^[\w-]+(\.[\w-]+)+(\/|$|\?)/.test(value)) return `https://${value}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
}

function getPage(tabId) {
  const tab = tabs.get(tabId || activeTabId);
  if (!tab) throw new Error("No such tab");
  return tab.page;
}

async function tabInfo(id) {
  const tab = tabs.get(id);
  if (!tab) return null;
  let title = "";
  let url = "";
  try {
    title = await tab.page.title();
    url = tab.page.url();
  } catch {
    /* page may be navigating */
  }
  return { id, title, url, viewport: tab.viewport, active: id === activeTabId };
}

async function listTabs() {
  const out = [];
  for (const id of tabs.keys()) {
    const info = await tabInfo(id);
    if (info) out.push(info);
  }
  return out;
}

async function readPage(tabId, maxChars = 12000) {
  const page = getPage(tabId);
  const data = await page.evaluate(() => {
    const pick = (sel) => Array.from(document.querySelectorAll(sel));
    const text = document.body ? document.body.innerText : "";
    const links = pick("a[href]")
      .slice(0, 120)
      .map((a) => ({ text: a.innerText.trim().slice(0, 80), href: a.href }))
      .filter((l) => l.text);
    const fields = pick("input,textarea,select,button")
      .slice(0, 80)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        placeholder: el.getAttribute("placeholder") || "",
        label: (el.getAttribute("aria-label") || el.innerText || "").trim().slice(0, 60),
      }));
    const media = {
      videos: pick("video").length,
      iframes: pick("iframe").length,
      images: pick("img").length,
    };
    return { title: document.title, url: location.href, text, links, fields, media };
  });
  data.text = String(data.text || "").slice(0, maxChars);
  return data;
}

const handlers = {
  list_tabs: () => listTabs(),
  new_tab: ({ url, viewport }) => newTab(url, viewport),
  close_tab: async ({ tabId }) => {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error("No such tab");
    await tab.page.close().catch(() => {});
    tabs.delete(tabId);
    if (activeTabId === tabId) activeTabId = tabs.keys().next().value ?? null;
    return listTabs();
  },
  activate_tab: async ({ tabId }) => {
    if (!tabs.has(tabId)) throw new Error("No such tab");
    activeTabId = tabId;
    await getPage(tabId).bringToFront();
    return tabInfo(tabId);
  },
  navigate: async ({ tabId, url }) => {
    const page = getPage(tabId);
    await page.goto(normalizeUrl(url), { waitUntil: "domcontentloaded", timeout: 60000 });
    return tabInfo(tabId || activeTabId);
  },
  back: async ({ tabId }) => {
    await getPage(tabId).goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    return tabInfo(tabId || activeTabId);
  },
  forward: async ({ tabId }) => {
    await getPage(tabId).goForward({ waitUntil: "domcontentloaded" }).catch(() => {});
    return tabInfo(tabId || activeTabId);
  },
  reload: async ({ tabId }) => {
    await getPage(tabId).reload({ waitUntil: "domcontentloaded" });
    return tabInfo(tabId || activeTabId);
  },
  set_viewport: async ({ tabId, viewport }) => {
    const id = tabId || activeTabId;
    const tab = tabs.get(id);
    if (!tab) throw new Error("No such tab");
    const vp = VIEWPORTS[viewport] ?? VIEWPORTS.desktop;
    await tab.page.setViewportSize({ width: vp.width, height: vp.height });
    tab.viewport = viewport;
    return tabInfo(id);
  },
  click_at: async ({ tabId, x, y }) => {
    await getPage(tabId).mouse.click(x, y);
    await getPage(tabId).waitForTimeout(300);
    return { ok: true };
  },
  click_text: async ({ tabId, text }) => {
    const page = getPage(tabId);
    const target = page.getByText(text, { exact: false }).first();
    await target.click({ timeout: 15000 });
    await page.waitForTimeout(500);
    return { ok: true };
  },
  click_selector: async ({ tabId, selector }) => {
    const page = getPage(tabId);
    await page.locator(selector).first().click({ timeout: 15000 });
    await page.waitForTimeout(500);
    return { ok: true };
  },
  type_text: async ({ tabId, text, selector }) => {
    const page = getPage(tabId);
    if (selector) await page.locator(selector).first().fill(text, { timeout: 15000 });
    else await page.keyboard.type(text, { delay: 20 });
    return { ok: true };
  },
  press_key: async ({ tabId, key }) => {
    await getPage(tabId).keyboard.press(key);
    await getPage(tabId).waitForTimeout(400);
    return { ok: true };
  },
  scroll: async ({ tabId, dy }) => {
    await getPage(tabId).mouse.wheel(0, dy ?? 600);
    return { ok: true };
  },
  read_page: ({ tabId, maxChars }) => readPage(tabId, maxChars),
  screenshot: async ({ tabId }) => {
    const buf = await getPage(tabId).screenshot({ type: "jpeg", quality: 70 });
    return { image: buf.toString("base64") };
  },
  wait: async ({ ms }) => {
    await new Promise((r) => setTimeout(r, Math.min(ms ?? 1000, 15000)));
    return { ok: true };
  },
};

const wss = new WebSocketServer({ port: PORT });
console.log(`EMA agent listening on ws://localhost:${PORT}`);

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (TOKEN && url.searchParams.get("token") !== TOKEN) {
    ws.close(4001, "bad token");
    return;
  }
  console.log("EMA web app connected");

  const timer = setInterval(async () => {
    if (ws.readyState !== ws.OPEN || !activeTabId) return;
    try {
      const page = getPage(activeTabId);
      const buf = await page.screenshot({ type: "jpeg", quality: 60 });
      ws.send(
        JSON.stringify({
          type: "frame",
          tabId: activeTabId,
          url: page.url(),
          title: await page.title().catch(() => ""),
          image: buf.toString("base64"),
        }),
      );
    } catch {
      /* transient */
    }
  }, Math.max(150, Math.round(1000 / FPS)));

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const handler = handlers[msg.method];
    if (!handler) {
      ws.send(JSON.stringify({ id: msg.id, ok: false, error: `Unknown method ${msg.method}` }));
      return;
    }
    try {
      const result = await handler(msg.params ?? {});
      ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (error) {
      ws.send(JSON.stringify({ id: msg.id, ok: false, error: String(error?.message ?? error) }));
    }
  });

  ws.on("close", () => {
    clearInterval(timer);
    console.log("EMA web app disconnected");
  });
});
