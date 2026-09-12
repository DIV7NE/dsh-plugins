// src/index.ts
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import nodePty from "node-pty";
import { WebSocketServer } from "ws";
var inject = ["webServer"];
var PREFIX = "/runterm";
var TRANSCRIPT_LIMIT = 1 << 18;
var DIM = { colsMin: 2, colsMax: 1e3, rowsMin: 2, rowsMax: 400 };
function pastePayload(code) {
  const body = code.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return body.replace(/\n/g, "\r") + "\r";
}
function appendTranscript(transcript, data) {
  const next = transcript + data;
  return next.length > TRANSCRIPT_LIMIT ? next.slice(next.length - TRANSCRIPT_LIMIT) : next;
}
function clampDim(value, min, max, fallback) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function isTrustedRequest(headers) {
  const header = (name) => {
    const value = headers[name];
    return typeof value === "string" ? value : void 0;
  };
  const host = header("host");
  if (host === void 0) return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (header("sec-fetch-site") === "cross-site") return false;
  const origin = header("origin");
  if (origin === void 0) return true;
  try {
    return new URL(origin).hostname === hostUrl.hostname;
  } catch {
    return false;
  }
}
function whichOnPath(name) {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return void 0;
}
function resolveShell(configured) {
  const trimmed = typeof configured === "string" ? configured.trim() : "";
  const explicit = trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"' ? trimmed.slice(1, -1) : trimmed;
  if (explicit !== "") return { file: explicit, args: process.platform === "win32" ? [] : ["-l"] };
  if (process.platform === "win32") {
    return { file: whichOnPath("pwsh.exe") ?? "powershell.exe", args: [] };
  }
  const shell = process.env.SHELL?.trim();
  return { file: shell !== void 0 && shell !== "" ? shell : "/bin/bash", args: ["-l"] };
}
function resolveCwd(requested) {
  if (requested !== null && requested !== "" && requested.length < 4096) {
    try {
      if (statSync(requested).isDirectory()) return requested;
    } catch {
    }
  }
  return process.cwd();
}
function sendFrame(ws, frame) {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
  }
}
function apply(ctx, config) {
  const terminals = /* @__PURE__ */ new Map();
  const shell = resolveShell(config?.shell);
  const kill = (terminal) => {
    if (terminals.get(terminal.sessionId) === terminal) terminals.delete(terminal.sessionId);
    try {
      terminal.pty.kill();
    } catch {
    }
  };
  const create = (sessionId, url) => {
    const cols = clampDim(url.searchParams.get("cols"), DIM.colsMin, DIM.colsMax, 80);
    const rows = clampDim(url.searchParams.get("rows"), DIM.rowsMin, DIM.rowsMax, 24);
    const cwd = resolveCwd(url.searchParams.get("cwd"));
    const pty = nodePty.spawn(shell.file, [...shell.args], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" }
    });
    const terminal = { sessionId, cwd, pty, clients: /* @__PURE__ */ new Set(), transcript: "", exited: false };
    terminals.set(sessionId, terminal);
    pty.onData((data) => {
      terminal.transcript = appendTranscript(terminal.transcript, data);
      for (const client of terminal.clients) sendFrame(client, { t: "data", d: data });
    });
    pty.onExit((event) => {
      terminal.exited = true;
      for (const client of terminal.clients) sendFrame(client, { t: "exit", code: event.exitCode });
    });
    return terminal;
  };
  ctx.effect(() => {
    const wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? PREFIX + "/pty", "http://localhost");
      const sessionId = url.searchParams.get("session") ?? "";
      if (sessionId === "") {
        ws.close(1008, "missing session");
        return;
      }
      let terminal = terminals.get(sessionId);
      if (terminal === void 0 || terminal.exited) {
        if (terminal !== void 0) terminals.delete(sessionId);
        try {
          terminal = create(sessionId, url);
        } catch (error) {
          sendFrame(ws, { t: "error", message: "cannot start " + shell.file + ": " + String(error) });
          ws.close(1011, "spawn failed");
          return;
        }
      }
      sendFrame(ws, { t: "data", d: terminal.transcript });
      terminal.clients.add(ws);
      sendFrame(ws, { t: "ready", shell: shell.file, cwd: terminal.cwd });
      ws.on("message", (raw) => {
        let frame;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (typeof frame !== "object" || frame === null) return;
        const message = frame;
        const live = terminals.get(sessionId);
        if (live === void 0 || live.exited) return;
        if (message.t === "input" && typeof message.d === "string") {
          live.pty.write(message.d);
        } else if (message.t === "run" && typeof message.code === "string") {
          live.pty.write(pastePayload(message.code));
        } else if (message.t === "resize") {
          try {
            live.pty.resize(
              clampDim(message.cols, DIM.colsMin, DIM.colsMax, 80),
              clampDim(message.rows, DIM.rowsMin, DIM.rowsMax, 24)
            );
          } catch {
          }
        } else if (message.t === "kill") {
          kill(live);
        }
      });
      const forget = () => {
        terminal?.clients.delete(ws);
      };
      ws.on("close", forget);
      ws.on("error", forget);
    });
    const disposeRoute = ctx.webServer.registerUpgrade({
      path: PREFIX + "/pty",
      handler: (req, socket, head) => {
        if (!isTrustedRequest(req.headers)) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      }
    });
    return () => {
      disposeRoute();
      for (const terminal of [...terminals.values()]) kill(terminal);
      terminals.clear();
      wss.close();
    };
  }, "dsh-run-in-terminal: pty route");
}
export {
  TRANSCRIPT_LIMIT,
  appendTranscript,
  apply,
  inject,
  isLoopbackHostname,
  isTrustedRequest,
  pastePayload,
  resolveShell
};
//# sourceMappingURL=index.js.map
