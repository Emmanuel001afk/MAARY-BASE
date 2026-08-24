/** Tool catalogue exposed to the AI. Executed in the browser against the agent. */
export const IRREVERSIBLE_HINT =
  "Anything that spends money, creates or deletes an account, deletes data, posts publicly, or sends a message is irreversible and must go through request_approval first.";

export const AI_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_tabs",
      description: "List all open browser tabs with their ids, titles and URLs.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "new_tab",
      description: "Open a new browser tab, optionally at a URL or search query.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL or search terms" },
          viewport: { type: "string", description: "desktop or mobile" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_tab",
      description: "Close a tab by id.",
      parameters: {
        type: "object",
        properties: { tabId: { type: "string" } },
        required: ["tabId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "activate_tab",
      description: "Switch to a tab by id, making it the visible one.",
      parameters: {
        type: "object",
        properties: { tabId: { type: "string" } },
        required: ["tabId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Navigate the active tab to a URL or search query.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" }, tabId: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "back",
      description: "Go back in history.",
      parameters: { type: "object", properties: { tabId: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "reload",
      description: "Reload the page.",
      parameters: { type: "object", properties: { tabId: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "read_page",
      description:
        "Read the current page: title, URL, visible text, links, form fields and media counts. Use this to understand, summarise, verify or extract anything.",
      parameters: {
        type: "object",
        properties: { tabId: { type: "string" }, maxChars: { type: "number" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "screenshot",
      description:
        "Capture what the page looks like right now. Use when layout or visuals matter.",
      parameters: { type: "object", properties: { tabId: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "click_text",
      description: "Click the first element containing this visible text.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" }, tabId: { type: "string" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click_selector",
      description: "Click an element by CSS selector.",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" }, tabId: { type: "string" } },
        required: ["selector"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description:
        "Type text. With a CSS selector it fills that field, without one it types into whatever is focused.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          selector: { type: "string" },
          tabId: { type: "string" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press_key",
      description: "Press a keyboard key such as Enter, Tab or Escape.",
      parameters: {
        type: "object",
        properties: { key: { type: "string" }, tabId: { type: "string" } },
        required: ["key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll the page vertically by a pixel amount (negative scrolls up).",
      parameters: {
        type: "object",
        properties: { dy: { type: "number" }, tabId: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_viewport",
      description: "Switch the tab between desktop and mobile rendering.",
      parameters: {
        type: "object",
        properties: { viewport: { type: "string" }, tabId: { type: "string" } },
        required: ["viewport"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait",
      description: "Wait for a number of milliseconds while a page loads.",
      parameters: { type: "object", properties: { ms: { type: "number" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "use_credential",
      description:
        "Fetch the saved login for a site from the owner's encrypted vault, then type it into the login form. Returns the username and password.",
      parameters: {
        type: "object",
        properties: { site: { type: "string", description: "Domain, e.g. github.com" } },
        required: ["site"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_approval",
      description: `Ask the owner to approve an irreversible action before doing it. ${IRREVERSIBLE_HINT}`,
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Plain-language description of what will happen" },
          details: { type: "string" },
        },
        required: ["summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "Save a durable note to long-term memory for future sessions.",
      parameters: {
        type: "object",
        properties: { content: { type: "string" }, scope: { type: "string" } },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall",
      description: "Search long-term memory for previously saved notes.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  },
];

export function systemPrompt(memories: string[], tabs: string): string {
  return [
    "You are EMA, the owner's personal AI browser. You drive a real Chromium browser through tools.",
    "You can open tabs, navigate anywhere, read text, watch media pages, fill forms, log in with the owner's vault, and summarise or verify anything.",
    "Work step by step: act, then read_page to check the result, then continue. Never claim something is done without verifying.",
    IRREVERSIBLE_HINT,
    "Never reveal passwords or secrets in your replies.",
    `Open tabs right now: ${tabs || "none"}`,
    memories.length ? `Long-term memory:\n- ${memories.join("\n- ")}` : "Long-term memory is empty.",
  ].join("\n");
}
