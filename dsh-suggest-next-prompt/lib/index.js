// src/protocol.ts
var SUGGEST_PATH = "/suggestnext/next";
var MAX_CANDIDATES = 3;
var MAX_CANDIDATE_CHARS = 100;
var MAX_MESSAGES = 12;
var MAX_MESSAGE_BYTES = 8192;
var MAX_BODY_BYTES = 262144;
function utf8Bytes(text) {
  return new TextEncoder().encode(text).length;
}
function isFailure(value) {
  return value.error !== void 0;
}
function parseRoute(value) {
  if (value === void 0) return void 0;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value;
  const provider = record["provider"];
  const model = record["model"];
  if (typeof provider !== "string" || provider.length === 0 || provider.length > 128) return null;
  if (typeof model !== "string" || model.length === 0 || model.length > 256) return null;
  return { provider, model };
}
function parseRequest(raw, byteLength) {
  if (byteLength > MAX_BODY_BYTES) return { status: 413, error: "body too large" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { status: 400, error: "body must be an object" };
  }
  const body = raw;
  for (const key of Object.keys(body)) {
    if (key !== "sessionId" && key !== "transcript" && key !== "route") {
      return { status: 400, error: "unknown field: " + key };
    }
  }
  const sessionId = body["sessionId"];
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256) {
    return { status: 400, error: "sessionId must be a non-empty string" };
  }
  const transcript = body["transcript"];
  if (!Array.isArray(transcript)) return { status: 400, error: "transcript must be an array" };
  if (transcript.length > MAX_MESSAGES) return { status: 400, error: "transcript too long" };
  const messages = [];
  for (const entry of transcript) {
    if (typeof entry !== "object" || entry === null) {
      return { status: 400, error: "transcript entry must be an object" };
    }
    const record = entry;
    const role = record["role"];
    const text = record["text"];
    if (role !== "user" && role !== "assistant") {
      return { status: 400, error: "role must be user or assistant" };
    }
    if (typeof text !== "string") return { status: 400, error: "text must be a string" };
    if (utf8Bytes(text) > MAX_MESSAGE_BYTES) return { status: 400, error: "message too large" };
    messages.push({ role, text });
  }
  const route = parseRoute(body["route"]);
  if (route === null) {
    return { status: 400, error: "route must carry non-empty provider and model strings" };
  }
  return route === void 0 ? { sessionId, transcript: messages } : { sessionId, transcript: messages, route };
}
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255);
}
function isTrustedRequest(headers) {
  const header = (name2) => {
    const value = headers[name2];
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
var COMMAND_TOKEN = /^\/([a-z0-9_-]+)/i;
function sanitizeCandidates(values, catalogue) {
  const known = new Set(catalogue);
  const out = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text.length === 0 || text.length > MAX_CANDIDATE_CHARS) continue;
    if (/[\r\n]/.test(text)) continue;
    if (/[\u0000-\u001f\u007f]/.test(text)) continue;
    const match = COMMAND_TOKEN.exec(text);
    if (match !== null && !known.has(match[1])) continue;
    if (out.includes(text)) continue;
    out.push(text);
    if (out.length === MAX_CANDIDATES) break;
  }
  return out;
}
function buildPrompt(request, catalogue) {
  const commandRule = catalogue.length === 0 ? "Do not suggest slash commands." : "Slash commands available in this session, which are the only ones you may suggest: " + catalogue.join(", ") + ".";
  const system = [
    "You propose the next prompt a developer should send to an AI coding agent.",
    "Return ONLY a JSON array of at most " + MAX_CANDIDATES + " single-line strings, ranked best first.",
    "Each string is the literal text placed in the composer: no markdown, no numbering, no surrounding quotes, no explanation.",
    "At most " + MAX_CANDIDATE_CHARS + " characters, one line each.",
    "Mix these kinds when each is genuinely best: the next concrete action, a short consent or steering reply,",
    "and a better alternative to the path the agent just took.",
    commandRule
  ].join(" ");
  return { system, user: JSON.stringify({ turns: request.transcript }) };
}

// src/index.ts
var name = "suggest-next-prompt";
var inject = ["webServer", "llm", "commands", "agents", "session"];
function resolveSettings(config) {
  const provider = typeof config?.provider === "string" ? config.provider : void 0;
  const model = typeof config?.model === "string" ? config.model : void 0;
  const maxCandidates = Math.min(3, Math.max(1, Math.floor(config?.maxCandidates ?? 3)));
  const timeoutMs = Math.min(3e4, Math.max(500, Math.floor(config?.timeoutMs ?? 8e3)));
  const maxOutputTokens = Math.min(2e3, Math.max(32, Math.floor(config?.maxOutputTokens ?? 400)));
  const reasoningEffort = typeof config?.reasoningEffort === "string" && config.reasoningEffort !== "" ? config.reasoningEffort : "off";
  return {
    reasoningEffort,
    ...provider !== void 0 && provider !== "" && model !== void 0 && model !== "" ? { route: { provider, model } } : {},
    maxCandidates,
    timeoutMs,
    maxOutputTokens
  };
}
async function collect(deps, route, prompt, sessionId, settings, signal) {
  const options = {
    provider: route.provider,
    model: route.model,
    system: prompt.system,
    messages: [{
      id: "suggest-next-prompt-" + String(Date.now()),
      role: "user",
      content: [{ type: "text", text: prompt.user }],
      source: { kind: "plugin", plugin: "dsh-suggest-next-prompt" }
    }],
    maxTokens: settings.maxOutputTokens,
    reasoningEffort: settings.reasoningEffort,
    sessionId,
    signal
  };
  const blocks = /* @__PURE__ */ new Map();
  let fallback = 0;
  let finish = "none";
  let failure;
  let usage;
  for await (const chunk of deps.stream(options)) {
    const type = chunk["type"];
    const index = typeof chunk["index"] === "number" ? chunk["index"] : fallback++;
    if (type === "text-delta" && typeof chunk["text"] === "string") {
      blocks.set(index, (blocks.get(index) ?? "") + chunk["text"]);
      continue;
    }
    if (type === "block-end") {
      const block = chunk["block"];
      if (block !== void 0 && block.type === "text" && typeof block.text === "string") {
        blocks.set(index, block.text);
      }
      continue;
    }
    if (type === "usage") {
      const reported = chunk["usage"];
      if (reported !== null && typeof reported === "object") usage = reported;
      continue;
    }
    if (type === "finish") {
      const reason = chunk["reason"];
      finish = typeof reason?.kind === "string" ? reason.kind : "unknown";
      const message = reason?.failure?.message;
      if (typeof message === "string") failure = message;
    }
  }
  const text = [...blocks.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1]).join("");
  const outcome = usage === void 0 ? { text, finish } : { text, finish, usage };
  return failure === void 0 ? outcome : { ...outcome, failure };
}
function extractArray(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
async function handleRequest(deps, request) {
  if (!isTrustedRequest(request.headers)) return { status: 403, body: { error: "forbidden" } };
  const parsed = parseRequest(request.raw, request.byteLength);
  if (isFailure(parsed)) return { status: parsed.status, body: { error: parsed.error } };
  const agent = deps.agents.get(parsed.sessionId);
  if (agent === void 0) return { status: 404, body: { error: "unknown session" } };
  const catalogue = deps.commands.list(agent).map((descriptor) => descriptor.name);
  const route = parsed.route ?? deps.settings.route;
  if (route === void 0) return { status: 200, body: { candidates: [] } };
  const prompt = buildPrompt(parsed, catalogue);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.settings.timeoutMs);
  let outcome;
  try {
    outcome = await collect(deps, route, prompt, parsed.sessionId, deps.settings, controller.signal);
  } catch {
    return { status: 200, body: { candidates: [] } };
  } finally {
    clearTimeout(timer);
  }
  if (outcome.finish === "error" || outcome.finish === "aborted") {
    return { status: 200, body: { candidates: [] } };
  }
  const candidates = sanitizeCandidates(extractArray(outcome.text), catalogue).slice(0, deps.settings.maxCandidates);
  try {
    deps.sessions.get(parsed.sessionId)?.append("session/suggest-llm-request", {
      route,
      model: route.model,
      reasoningEffort: deps.settings.reasoningEffort,
      maxTokens: deps.settings.maxOutputTokens,
      finish: outcome.finish,
      candidates: candidates.length,
      ...outcome.usage === void 0 ? {} : { usage: outcome.usage }
    });
  } catch {
  }
  return { status: 200, body: { candidates } };
}
async function readBody(req, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = chunk;
    bytes += buf.length;
    if (bytes > limit) return null;
    chunks.push(buf);
  }
  return { raw: Buffer.concat(chunks).toString("utf8"), bytes };
}
function send(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}
function apply(ctx, config) {
  if (config?.enabled === false) return;
  const settings = resolveSettings(config);
  const deps = {
    settings,
    agents: ctx.agents,
    commands: ctx.commands,
    sessions: ctx.session,
    stream: (options) => ctx.llm.stream(options)
  };
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: SUGGEST_PATH,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        send(res, 405, { error: "method not allowed" });
        return;
      }
      const body = await readBody(req, MAX_BODY_BYTES).catch(() => null);
      if (body === null) {
        send(res, 413, { error: "body too large" });
        return;
      }
      let raw;
      try {
        raw = JSON.parse(body.raw);
      } catch {
        send(res, 400, { error: "body must be JSON" });
        return;
      }
      const result = await handleRequest(deps, { headers: req.headers, byteLength: body.bytes, raw });
      send(res, result.status, result.body);
    }
  }), "suggest-next-prompt: route");
}
export {
  apply,
  handleRequest,
  inject,
  name
};
