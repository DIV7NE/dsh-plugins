// src/index.ts
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { WebSocketServer } from "ws";
var inject = ["webServer", "tools"];
var ROUTE = "/chrome-agent/bridge";
var CALL_TIMEOUT_MS = 3e4;
var EXTENSION_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApbeP6/mjVhlNg3yyIUPO2Y6whmWVUzSZid84ehqXkScIGUBfZiGZ3i3nSFEu7COJkpo7TtvuhDmAiEzZIbmBha4csAHg7If8w7JEUK8KE7adw953sfbcgEJEF1P5HwNDLrq7WHgCphEMK3bx1ppTap9qv+ATRGnFAbLdcEhfi0NXGUsETVC2uPfX5qIeCLUXCXajUhkYQyCVksUWlwRXEXFw76MxigriFVC0Dy+Vn9y8+EguUfRr0rHqPkqPXwtjcf8/Vh7L3lowXajJV08lzFY7qLpl0iKkyDnLsRNsjA3xHFNvL5e+c4GalaSjzcYNq8zP6Mr6qNdUYIsfIoGMzwIDAQAB";
function deriveExtensionId(publicKeyBase64) {
  const hex = createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("hex").slice(0, 32);
  let id = "";
  for (const digit of hex) id += String.fromCharCode(97 + parseInt(digit, 16));
  return id;
}
var EXTENSION_ID = deriveExtensionId(EXTENSION_KEY);
var EXTENSION_ORIGIN = "chrome-extension://" + EXTENSION_ID;
function isTrustedBridgeRequest(headers) {
  return headers.origin === EXTENSION_ORIGIN;
}
var Bridge = class {
  socket;
  version = "";
  seq = 0;
  pending = /* @__PURE__ */ new Map();
  /** Adopt a freshly accepted socket, dropping any previous one. */
  attach(socket) {
    const previous = this.socket;
    this.socket = socket;
    this.version = "";
    if (previous !== void 0 && previous !== socket) {
      try {
        previous.close();
      } catch {
      }
    }
    const drop = () => {
      if (this.socket !== socket) return;
      this.socket = void 0;
      this.version = "";
    };
    socket.on("message", (raw) => this.onMessage(raw));
    socket.on("close", drop);
    socket.on("error", drop);
  }
  /** Route one frame from the extension. */
  onMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    if (frame.t === "hello") {
      this.version = typeof frame.version === "string" ? frame.version : "";
      return;
    }
    if (frame.t !== "result" || typeof frame.id !== "number") return;
    const entry = this.pending.get(frame.id);
    if (entry === void 0) return;
    this.pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.ok === true) entry.resolve(frame.value);
    else entry.reject(new Error(typeof frame.error === "string" ? frame.error : "the extension reported a failure"));
  }
  /** Whether a usable extension connection is present. */
  connected() {
    return this.socket !== void 0 && this.socket.readyState === 1;
  }
  /** The extension's self-reported version, empty before it says hello. */
  extensionVersion() {
    return this.version;
  }
  /**
   * Run one command on the extension.
   * @param method - command name defined by the extension's protocol.
   * @param params - JSON-serializable command parameters.
   * @param timeoutMs - how long to wait before failing the call.
   * @returns the command's value.
   */
  call(method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
    const socket = this.socket;
    if (socket === void 0 || socket.readyState !== 1) {
      return Promise.reject(new Error(
        "the companion Chrome extension is not connected \u2014 load extension/ unpacked in chrome://extensions (Developer mode) and make sure the DSH server is running"
      ));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("chrome-agent: " + method + " timed out after " + timeoutMs + "ms"));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => {
        resolve(value);
      }, reject, timer });
      try {
        socket.send(JSON.stringify({ t: "command", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  /** Fail every in-flight call and drop the socket. */
  dispose() {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("chrome-agent: plugin unloading"));
    }
    this.pending.clear();
    try {
      this.socket?.close();
    } catch {
    }
    this.socket = void 0;
    this.version = "";
  }
};
var BATCHABLE_TOOLS = /* @__PURE__ */ new Set([
  "chrome_open",
  "chrome_close",
  "chrome_snapshot",
  "chrome_click",
  "chrome_hover",
  "chrome_drag",
  "chrome_scroll",
  "chrome_type",
  "chrome_key",
  "chrome_wait_for",
  "chrome_eval",
  "chrome_page_text",
  "chrome_find",
  "chrome_screenshot",
  "chrome_console",
  "chrome_network",
  "chrome_resize",
  "chrome_upload"
]);
function resolveBatchStep(tool, args, defaultTabId) {
  if (typeof tool !== "string" || tool === "") return { ok: false, error: "every action needs a tool name" };
  if (!BATCHABLE_TOOLS.has(tool)) {
    return { ok: false, error: tool + " cannot run inside chrome_batch" };
  }
  const source = args === void 0 || args === null ? {} : args;
  if (typeof source !== "object" || Array.isArray(source)) {
    return { ok: false, error: tool + ": args must be an object" };
  }
  const params = { ...source };
  if (params.tabId === void 0 && defaultTabId !== void 0) params.tabId = defaultTabId;
  const method = tool.slice("chrome_".length).replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
  return { ok: true, tool, method, params };
}
function textRender(fn) {
  return (_args, value) => [
    { type: "text", text: fn(value) }
  ];
}
function bullet(items) {
  return items.length === 0 ? "(none)" : items.join("\n");
}
function summarizeBatchValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const limit = 4e3;
  return text.length > limit ? text.slice(0, limit) + "\u2026 (truncated)" : text;
}
async function captureScreenshot(bridge, args) {
  const captured = await bridge.call("screenshot", { tabId: args.tabId });
  const base64 = typeof captured?.base64 === "string" ? captured.base64 : "";
  if (base64 === "") throw new Error("chrome-agent: the extension returned no image data");
  const bytes = Buffer.from(base64, "base64");
  const extension = captured?.format === "jpeg" ? ".jpg" : ".png";
  const path = typeof args.savePath === "string" && args.savePath !== "" ? args.savePath : join(tmpdir(), "dsh-chrome-" + randomUUID() + extension);
  await writeFile(path, bytes);
  return { path, bytes: bytes.byteLength };
}
function registerTools(ctx, bridge) {
  ctx.effect(() => {
    const disposers = [];
    const register = (tool) => {
      disposers.push(ctx.tools.register(tool));
    };
    register(defineTool({
      name: "chrome_status",
      description: "Report whether the companion Chrome extension is connected to this DSH server. Call this first when a browser tool fails, or when unsure whether the user has the browser available.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            connected: { type: "boolean", required: true },
            version: { type: "string", required: true, description: "Extension version, empty when not connected." },
            extensionId: { type: "string", required: true }
          }
        },
        render: textRender(
          (value) => value.connected ? "Chrome extension connected (version " + (value.version === "" ? "unknown" : value.version) + ", id " + value.extensionId + ")." : "Chrome extension NOT connected (expected id " + value.extensionId + "). Ask the user to load extension/ unpacked in chrome://extensions with Developer mode on, then retry."
        )
      },
      execute: async () => ({
        connected: bridge.connected(),
        version: bridge.extensionVersion(),
        extensionId: EXTENSION_ID
      })
    }));
    register(defineTool({
      name: "chrome_tabs",
      description: "List the tabs open in the user's Chrome: id, title, url, and which is active. Use a returned id as `tabId` for the other chrome_* tools; omit `tabId` to act on the tab the agent is working in.",
      parameters: {},
      output: {
        schema: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "integer", required: true },
              title: { type: "string", required: true },
              url: { type: "string", required: true },
              active: { type: "boolean", required: true },
              groupId: { type: "integer", required: true, description: "Tab group id, or -1 when the tab is ungrouped. Agent-opened tabs share one group." },
              agent: { type: "boolean", required: true, description: "True when the agent opened this tab \u2014 it is in the agent's own group." }
            }
          }
        },
        render: textRender(
          (tabs) => bullet(tabs.map((t) => (t.active ? "* " : "  ") + t.id + "  " + t.title + "  " + t.url + (t.groupId === -1 ? "" : "  [group " + t.groupId + "]") + (t.agent ? "  [agent]" : "")))
        )
      },
      execute: async () => bridge.call("tabs")
    }));
    register(defineTool({
      name: "chrome_open",
      description: "Navigate a Chrome tab to a URL. Set `newTab` to open a fresh tab in the agent's own group \u2014 prefer that, or pass a `tabId` for a tab you already opened, so you never navigate a tab the user is reading. Without either, this navigates the tab the agent is working in. Opening a tab also makes it the tab later calls act on by default. This is the user's real browser, already signed in.",
      parameters: {
        url: { type: "string", required: true, description: "Absolute http(s) URL to open." },
        tabId: { type: "integer", description: "Target tab id from chrome_tabs. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." },
        newTab: { type: "boolean", description: "Open a new tab instead of reusing one." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            tabId: { type: "integer", required: true },
            url: { type: "string", required: true },
            title: { type: "string", required: true }
          }
        },
        render: textRender(
          (v) => "Opened tab " + v.tabId + ": " + v.title + " (" + v.url + ")"
        )
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        return bridge.call("open", args);
      }
    }));
    register(defineTool({
      name: "chrome_snapshot",
      description: 'Read the page as a compact text tree of interactive elements, each annotated with a ref like [ref=7]. This is the primary way to see a page \u2014 read the snapshot, then pass a ref to chrome_click or chrome_type. Cheaper and more reliable than a screenshot for anything but layout and images. A ref from inside a frame is written [ref=7 frame=f1] and must be passed back with frame: "f1"; chrome_page_text stays main-page only.',
      parameters: {
        tabId: { type: "integer", description: "Target tab id from chrome_tabs. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: { type: "string", required: true },
            title: { type: "string", required: true },
            snapshot: { type: "string", required: true, description: "The annotated page tree." }
          }
        },
        render: textRender(
          (v) => v.title + " \u2014 " + v.url + "\n\n" + v.snapshot
        )
      },
      execute: async (args) => bridge.call("snapshot", args)
    }));
    register(defineTool({
      name: "chrome_click",
      description: "Click an element. Prefer `ref` from the latest chrome_snapshot. Use `selector` for a CSS selector, or `x`/`y` for raw viewport coordinates. Dispatches trusted input events at the element's centre. Chrome routes no mouse input to a hidden tab, so this brings the agent's tab to the front for the moment it acts, moving the user's view there.",
      parameters: {
        ref: { type: "integer", description: "Element ref from chrome_snapshot (e.g. 7)." },
        selector: { type: "string", description: "CSS selector, when no ref is known." },
        x: { type: "integer", description: "Viewport x, with y, for a coordinate click." },
        y: { type: "integer", description: "Viewport y, with x, for a coordinate click." },
        button: { type: "string", description: "Which button: left (default), right, or middle." },
        clicks: { type: "integer", description: "1 (default), 2 for a double click, or 3 for a triple click." },
        frame: {
          type: "string",
          description: 'Frame the ref belongs to, as chrome_snapshot writes it (e.g. "f1"). Omit for the main page.'
        },
        tabId: { type: "integer", description: "Target tab id. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            clicked: { type: "string", required: true, description: "What was clicked, as the extension described it." }
          }
        },
        render: textRender((v) => "Clicked " + v.clicked + ". Take a fresh chrome_snapshot to see the result.")
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        return bridge.call("click", args);
      }
    }));
    register(defineTool({
      name: "chrome_type",
      description: "Type text into an element, or into whatever is focused when neither `ref` nor `selector` is given. Set `submit` to press Enter afterwards (search boxes, forms).",
      parameters: {
        text: { type: "string", required: true, description: "The text to type." },
        ref: { type: "integer", description: "Element ref from chrome_snapshot; focused when omitted." },
        selector: { type: "string", description: "CSS selector, when no ref is known." },
        submit: { type: "boolean", description: "Press Enter after typing." },
        frame: {
          type: "string",
          description: 'Frame the ref belongs to, as chrome_snapshot writes it (e.g. "f1"). Omit for the main page.'
        },
        tabId: { type: "integer", description: "Target tab id. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { typed: { type: "boolean", required: true }, submitted: { type: "boolean", required: true } }
        },
        render: textRender(
          (v) => v.submitted ? "Typed the text and pressed Enter." : "Typed the text."
        )
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        return bridge.call("type", args);
      }
    }));
    register(defineTool({
      name: "chrome_key",
      description: `Press a single key or chord on the page, e.g. "Enter", "Escape", "PageDown", "Control+a". Use chrome_type for text and this for navigation and shortcuts. Chrome drops key events on tabs that are not visible, so this brings the agent's tab to the front for the moment it acts, moving the user's view there.`,
      parameters: {
        key: { type: "string", required: true, description: 'Key or chord, e.g. "Tab", "Control+Enter".' },
        tabId: { type: "integer", description: "Target tab id. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { pressed: { type: "string", required: true } }
        },
        render: textRender((v) => "Pressed " + v.pressed + ".")
      },
      execute: async (args) => bridge.call("key", args)
    }));
    register(defineTool({
      name: "chrome_eval",
      description: "Evaluate a JavaScript expression in the page and return its value. Returns a serialized value (JSON, or a description for host objects). Use it to read data the snapshot does not surface.",
      parameters: {
        expression: { type: "string", required: true, description: "A JavaScript expression. Wrap multi-statement work in an IIFE." },
        tabId: { type: "integer", description: "Target tab id. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { result: { type: "string", required: true } }
        },
        render: textRender((v) => v.result)
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        return bridge.call("eval", args);
      }
    }));
    register(defineTool({
      name: "chrome_close",
      description: "Close a tab. Use it to tidy up tabs you opened; do not close a tab the user was already using unless they asked.",
      parameters: {
        tabId: { type: "integer", required: true, description: "Tab id from chrome_tabs or chrome_open." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { closed: { type: "integer", required: true } }
        },
        render: textRender((v) => "Closed tab " + v.closed + ".")
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        return bridge.call("close", args);
      }
    }));
    register(defineTool({
      name: "chrome_screenshot",
      description: "Capture the visible area of a tab and save it to disk, returning the file path. The file is a PNG, or a JPEG when the capture is very large. Use it for layout, images, canvas, or when the text snapshot is not enough; read the returned path with the image reader.",
      parameters: {
        tabId: { type: "integer", description: "Target tab id. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." },
        savePath: { type: "string", description: "Absolute path to write the screenshot to. Defaults to a temp file." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true },
            bytes: { type: "integer", required: true }
          }
        },
        render: textRender(
          (v) => "Saved a " + v.bytes + "-byte screenshot to " + v.path + "."
        )
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        return captureScreenshot(bridge, args);
      }
    }));
    register(defineTool({
      name: "chrome_hover",
      description: "Move the pointer over an element without clicking. Use it to open hover menus and tooltips, or to make a page reveal controls before you click them. Chrome routes no mouse input to a hidden tab, so this brings the agent's tab to the front for the moment it acts, moving the user's view there.",
      parameters: {
        ref: { type: "integer", description: "Element ref from chrome_snapshot." },
        selector: { type: "string", description: "CSS selector, when no ref is known." },
        x: { type: "integer", description: "Viewport x, with y." },
        y: { type: "integer", description: "Viewport y, with x." },
        frame: {
          type: "string",
          description: 'Frame the ref belongs to, as chrome_snapshot writes it (e.g. "f1"). Omit for the main page.'
        },
        tabId: { type: "integer", description: "Target tab id. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { hovered: { type: "string", required: true } }
        },
        render: textRender((v) => "Hovering " + v.hovered + ".")
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        return bridge.call("hover", args);
      }
    }));
    register(defineTool({
      name: "chrome_drag",
      description: "Drag from one point to another, e.g. a slider, a sortable row, or a canvas handle. Give each end as a snapshot ref, a CSS selector, or x+y coordinates. This drives mouse events, so it does not move native HTML5 drag-and-drop payloads (file drops, native reordering). Chrome routes no mouse input to a hidden tab, so this brings the agent's tab to the front for the moment it acts, moving the user's view there.",
      parameters: {
        fromRef: { type: "integer", description: "Start element ref from chrome_snapshot." },
        fromSelector: { type: "string", description: "Start CSS selector." },
        fromX: { type: "integer", description: "Start viewport x." },
        fromY: { type: "integer", description: "Start viewport y." },
        toRef: { type: "integer", description: "End element ref from chrome_snapshot." },
        toSelector: { type: "string", description: "End CSS selector." },
        toX: { type: "integer", description: "End viewport x." },
        toY: { type: "integer", description: "End viewport y." },
        fromFrame: {
          type: "string",
          description: "Frame the fromRef belongs to, as chrome_snapshot writes it. Omit for the main page."
        },
        toFrame: {
          type: "string",
          description: "Frame the toRef belongs to, as chrome_snapshot writes it. Omit for the main page."
        },
        tabId: { type: "integer", description: "Target tab id. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { dragged: { type: "string", required: true } }
        },
        render: textRender((v) => "Dragged " + v.dragged + ".")
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        return bridge.call("drag", args);
      }
    }));
    register(defineTool({
      name: "chrome_scroll",
      description: "Scroll the page. Pass a ref or selector to bring that element into view, or no target to scroll by deltaY (default 600, positive scrolls down). Most pages need scrolling before their content is in the snapshot or reachable by a click.",
      parameters: {
        ref: { type: "integer", description: "Element to scroll into view." },
        selector: { type: "string", description: "CSS selector to scroll into view." },
        deltaY: { type: "integer", description: "Pixels to scroll vertically when there is no target." },
        deltaX: { type: "integer", description: "Pixels to scroll horizontally when there is no target." },
        frame: {
          type: "string",
          description: 'Frame the ref belongs to, as chrome_snapshot writes it (e.g. "f1"). Omit for the main page.'
        },
        tabId: { type: "integer", description: "Target tab id. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { scrolled: { type: "string", required: true } }
        },
        render: textRender((v) => "Scrolled " + v.scrolled + ".")
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        return bridge.call("scroll", args);
      }
    }));
    register(defineTool({
      name: "chrome_wait_for",
      description: "Wait until a JavaScript expression in the page turns truthy. This is the ONLY supported way to wait; never sleep for a guessed duration. A fixed sleep must cover the slowest case, so it is either too short and flaky or too long and wasted, while this returns the moment the page is ready. The first check runs immediately, so a condition that already holds costs one round trip. Throws when the timeout elapses, naming the last value.",
      parameters: {
        expression: { type: "string", required: true, description: 'A JavaScript expression that is truthy once the page is ready, e.g. !!document.querySelector(".results").' },
        timeout: { type: "integer", description: "Give up after this many milliseconds (default 5000, max 30000)." },
        frame: { type: "string", description: "Frame key from chrome_snapshot, when the condition is inside a child frame." },
        tabId: { type: "integer", description: "Target tab id. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            matched: { type: "boolean", required: true },
            waited: { type: "integer", required: true },
            checks: { type: "integer", required: true }
          }
        },
        render: textRender(
          (v) => "Condition met after " + v.waited + "ms (" + v.checks + " check" + (v.checks === 1 ? "" : "s") + ")."
        )
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        return bridge.call("waitFor", args);
      }
    }));
    register(defineTool({
      name: "chrome_page_text",
      description: "Read the page as prose, preferring the article body over the whole document. Cheaper than a snapshot when you want to read or summarise rather than interact \u2014 navigation, banners and footers are dropped.",
      parameters: {
        tabId: { type: "integer", description: "Target tab id. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: { type: "string", required: true },
            title: { type: "string", required: true },
            text: { type: "string", required: true },
            truncated: { type: "boolean", required: true }
          }
        },
        render: textRender((v) => v.title + " \u2014 " + v.url + "\n\n" + v.text + (v.truncated ? "\n\n[truncated]" : ""))
      },
      execute: async (args) => bridge.call("pageText", args)
    }));
    register(defineTool({
      name: "chrome_find",
      description: "Look for a string in the text the page is showing, and scroll the first hit into view. Returns how many times it appears and a short quote around each of the first few. Use it to locate something on a long page instead of reading the whole snapshot.",
      parameters: {
        text: { type: "string", required: true, description: "The text to look for (case-insensitive)." },
        tabId: { type: "integer", description: "Target tab id. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            count: { type: "integer", required: true },
            matches: { type: "array", required: true, items: { type: "string" } },
            skipped: { type: "integer", required: true, description: "Frames the 12-frame cap left unread." },
            unread: { type: "array", required: true, items: { type: "string" }, description: "Frame keys that were in range but could not be read." }
          }
        },
        render: textRender((v) => {
          const head = v.count === 0 ? "No matches." : v.count + " match(es):\n" + v.matches.map((m) => "  \u2026" + m + "\u2026").join("\n");
          const notes = [];
          if (v.skipped > 0) notes.push(v.skipped + " further frame(s) not read");
          if (v.unread.length > 0) notes.push(v.unread.length + " frame(s) could not be read (" + v.unread.join(", ") + ")");
          return notes.length === 0 ? head : head + "\n\n\u2026 " + notes.join("; ");
        })
      },
      execute: async (args) => bridge.call("find", args)
    }));
    register(defineTool({
      name: "chrome_console",
      description: "Read the console messages and uncaught exceptions a tab has produced since you last read them (pass keep to read without clearing). Use it when a page misbehaves after an action.",
      parameters: {
        keep: { type: "boolean", description: "Read without clearing the buffer." },
        tabId: { type: "integer", description: "Target tab id. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            entries: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  level: { type: "string", required: true },
                  text: { type: "string", required: true }
                }
              }
            }
          }
        },
        render: textRender((v) => v.entries.length === 0 ? "No console output." : v.entries.map((e) => "[" + e.level + "] " + e.text).join("\n"))
      },
      execute: async (args) => bridge.call("console", args)
    }));
    register(defineTool({
      name: "chrome_network",
      description: "Read the HTTP requests a tab made since you last read them (pass keep to read without clearing), with the response status where one was seen. Use it to find the API behind a page, or to see what a click actually triggered.",
      parameters: {
        keep: { type: "boolean", description: "Read without clearing the buffer." },
        tabId: { type: "integer", description: "Target tab id. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            entries: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  method: { type: "string", required: true },
                  url: { type: "string", required: true },
                  type: { type: "string", required: true },
                  status: { type: "integer", required: true }
                }
              }
            }
          }
        },
        render: textRender((v) => v.entries.length === 0 ? "No requests recorded." : v.entries.map((e) => (e.status === 0 ? "\xB7\xB7\xB7" : String(e.status)) + " " + e.method + " " + e.url).join("\n"))
      },
      execute: async (args) => bridge.call("network", args)
    }));
    register(defineTool({
      name: "chrome_resize",
      description: "Emulate a viewport size for responsive testing. This changes what the page lays out against without moving the window the user is working in; pass width 0 (or height 0) to clear it.",
      parameters: {
        width: { type: "integer", required: true, description: "Viewport width in CSS pixels, or 0 to clear." },
        height: { type: "integer", required: true, description: "Viewport height in CSS pixels, or 0 to clear." },
        scale: { type: "number", description: "Device scale factor; 0 leaves it alone." },
        mobile: { type: "boolean", description: "Emulate a mobile device." },
        tabId: { type: "integer", description: "Target tab id. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { resized: { type: "string", required: true } }
        },
        render: textRender((v) => "Viewport " + v.resized + ".")
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        return bridge.call("resize", args);
      }
    }));
    register(defineTool({
      name: "chrome_upload",
      description: "Attach local files to a file input on the page. Pass a ref or selector, or let it use the only file input. Paths are read by the browser machine, so they must exist there \u2014 a path returned by chrome_screenshot works.",
      parameters: {
        files: {
          type: "array",
          required: true,
          description: "Absolute paths to attach.",
          items: { type: "string" }
        },
        ref: { type: "integer", description: "The input[type=file] ref from chrome_snapshot." },
        selector: { type: "string", description: "CSS selector for the input." },
        frame: {
          type: "string",
          description: 'Frame the ref belongs to, as chrome_snapshot writes it (e.g. "f1"). Omit for the main page.'
        },
        tabId: { type: "integer", description: "Target tab id. Defaults to the tab the agent is working in \u2014 the last one it opened or was given. Pass an explicit id to work on another tab." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { uploaded: { type: "integer", required: true } }
        },
        render: textRender((v) => "Attached " + v.uploaded + " file(s).")
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        return bridge.call("upload", args);
      }
    }));
    register(defineTool({
      name: "chrome_batch",
      description: "Run several browser actions in one call. Each action names another chrome_* tool and its arguments. Prefer this whenever you can predict two or more steps ahead \u2014 a click then a type then a key, a form fill, a multi-step navigation. One batch is one round trip instead of one per action, which is where the time goes. Every argument must be known before the batch is submitted, so use CSS selectors rather than refs produced by a snapshot inside the same batch, and put chrome_wait_for between steps instead of guessing a delay. Actions run in order and stop at the first failure; the result reports which action failed and how many never ran. chrome_status, chrome_tabs and chrome_batch itself are not allowed inside a batch.",
      parameters: {
        actions: {
          type: "array",
          required: true,
          description: "The actions to run, in order.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              tool: { type: "string", required: true, description: "A browser tool name, e.g. chrome_click." },
              args: {
                type: "object",
                additionalProperties: true,
                description: "That tool's arguments, exactly as you would pass them on their own."
              }
            }
          }
        },
        tabId: { type: "integer", description: "Default tab for every action that omits one." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ran: { type: "integer", required: true },
            total: { type: "integer", required: true },
            results: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  tool: { type: "string", required: true },
                  output: { type: "string", required: true, description: "That action's result, as text." }
                }
              }
            },
            failedTool: { type: "string", required: true, description: "Empty when every action ran." },
            error: { type: "string", required: true, description: "Empty when every action ran." },
            notRun: { type: "integer", required: true }
          }
        },
        render: textRender((v) => v.failedTool === "" ? "Ran all " + v.total + " action(s)." : "Stopped at action " + (v.ran + 1) + " (" + v.failedTool + "): " + v.error + " \u2014 " + v.ran + " ran, " + v.notRun + " not run.")
      },
      execute: async (args, exec) => {
        const actions = Array.isArray(args.actions) ? args.actions : [];
        if (actions.length === 0) throw new Error("chrome_batch needs at least one action");
        const results = [];
        const stop = (failedTool, error, attempted) => ({
          ran: results.length,
          total: actions.length,
          results,
          failedTool,
          error,
          notRun: actions.length - results.length - (attempted ? 1 : 0)
        });
        for (let index = 0; index < actions.length; index += 1) {
          const action = actions[index];
          const step = resolveBatchStep(action?.tool, action?.args, args.tabId);
          if (!step.ok) {
            const named = typeof action?.tool === "string" ? action.tool : "";
            return stop(named, "action " + (index + 1) + ": " + step.error, false);
          }
          exec.signal.throwIfAborted();
          try {
            const value = step.method === "screenshot" ? await captureScreenshot(bridge, step.params) : await bridge.call(step.method, step.params);
            results.push({ tool: step.tool, output: summarizeBatchValue(value) });
          } catch (error) {
            return stop(step.tool, error instanceof Error ? error.message : String(error), true);
          }
        }
        return { ran: results.length, total: actions.length, results, failedTool: "", error: "", notRun: 0 };
      }
    }));
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }, "dsh-chrome-agent: browser tools");
}
function apply(ctx) {
  const bridge = new Bridge();
  ctx.effect(() => {
    const wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (ws) => {
      bridge.attach(ws);
    });
    const disposeRoute = ctx.webServer.registerUpgrade({
      path: ROUTE,
      handler: (req, socket, head) => {
        if (!isTrustedBridgeRequest(req.headers)) {
          const raw = socket;
          raw.write?.("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          raw.destroy?.();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      }
    });
    return () => {
      disposeRoute();
      bridge.dispose();
      wss.close();
    };
  }, "dsh-chrome-agent: bridge route");
  registerTools(ctx, bridge);
}
export {
  BATCHABLE_TOOLS,
  Bridge,
  EXTENSION_ID,
  EXTENSION_KEY,
  apply,
  deriveExtensionId,
  inject,
  isTrustedBridgeRequest,
  resolveBatchStep,
  summarizeBatchValue
};
//# sourceMappingURL=index.js.map
