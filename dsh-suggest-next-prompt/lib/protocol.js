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
export {
  MAX_BODY_BYTES,
  MAX_CANDIDATES,
  MAX_CANDIDATE_CHARS,
  MAX_MESSAGES,
  MAX_MESSAGE_BYTES,
  SUGGEST_PATH,
  buildPrompt,
  isFailure,
  isLoopbackHostname,
  isTrustedRequest,
  parseRequest,
  sanitizeCandidates,
  utf8Bytes
};
