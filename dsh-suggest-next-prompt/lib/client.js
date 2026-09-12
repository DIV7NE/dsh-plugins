window.__ModuleLoader__.load({
	id: "dsh-suggest-next-prompt",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/suggest.tsx
var import_react = require("react");

// src/protocol.ts
var SUGGEST_PATH = "/suggestnext/next";
var MAX_MESSAGES = 12;

// src/client/fetch.ts
async function requestSuggestions(sessionId, transcript, route, signal, path = SUGGEST_PATH) {
  if (transcript.length === 0) return [];
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(route === void 0 ? { sessionId, transcript } : { sessionId, transcript, route }),
      signal,
      credentials: "same-origin"
    });
    if (!response.ok) return [];
    const payload = await response.json();
    if (!Array.isArray(payload.candidates)) return [];
    return payload.candidates.filter((value) => typeof value === "string");
  } catch {
    return [];
  }
}

// src/client/placeholder.ts
var PLACEHOLDER_SELECTOR = "[data-composer-placeholder]";
function findPlaceholder(from) {
  if (from === null) return null;
  const card = from.closest('[class*="root"], form') ?? from.parentElement;
  const found = card?.querySelector(PLACEHOLDER_SELECTOR) ?? null;
  return found;
}
function applySuggestion(node, text) {
  if (node === null || text === null) return false;
  if (node.textContent !== text) node.textContent = text;
  return true;
}
function shellPlaceholderText(from) {
  if (from === null) return null;
  const card = from.closest('[class*="root"], form') ?? from.parentElement;
  const editor = card?.querySelector("[data-placeholder]") ?? null;
  return editor?.getAttribute("data-placeholder") ?? null;
}

// src/client/keys.ts
function decideKey(event, state) {
  if (!state.visible || !state.empty) return "ignore";
  if (event.isComposing === true) return "ignore";
  if (event.key === "Tab") return event.shiftKey ? "ignore" : "accept";
  if (event.key === "ArrowDown") return "next";
  if (event.key === "ArrowUp") return "prev";
  if (event.key === "Escape") return "dismiss";
  return "ignore";
}

// src/client/route.ts
function sessionRoute(ctx, sessionId) {
  try {
    const sessions = ctx.get("sessions");
    if (sessions === void 0) return void 0;
    const face = sessions.binding(sessionId)?.session.projections.faceOf("modelSelection");
    const value = face?.getSnapshot();
    const pick = value?.next ?? value?.lastUsed;
    if (pick === void 0 || pick === null) return void 0;
    const provider = pick.provider;
    const model = pick.model;
    if (typeof provider !== "string" || provider === "") return void 0;
    if (typeof model !== "string" || model === "") return void 0;
    return { provider, model };
  } catch {
    return void 0;
  }
}

// src/client/transcript.ts
function buildTranscript(entries) {
  if (entries === void 0 || entries.length === 0) return [];
  const out = [];
  for (const entry of entries) {
    const prompt = entry.prompt.trim();
    if (prompt !== "") out.push({ role: "user", text: prompt });
    const response = entry.response.trim();
    if (response !== "") out.push({ role: "assistant", text: response });
  }
  return out.slice(Math.max(0, out.length - MAX_MESSAGES));
}
function lastTurnComplete(entries) {
  if (entries === void 0 || entries.length === 0) return false;
  const last = entries[entries.length - 1];
  return last !== void 0 && last.response.trim() !== "";
}
function newestTurn(entries) {
  if (entries === void 0 || entries.length === 0) return null;
  const last = entries[entries.length - 1];
  return last === void 0 ? null : last.turn;
}

// src/client/suggest.tsx
var import_jsx_runtime = require("react/jsx-runtime");
function SuggestOverlay({ useInput, useSession, useProjection, inputActions, ctx, sessionId }) {
  const draft = useInput((state) => state.draft);
  const running = useSession((session) => session.running);
  const removed = useSession((session) => session.removed);
  const outline = useProjection("turnOutline");
  const hostRef = (0, import_react.useRef)(null);
  const abortRef = (0, import_react.useRef)(null);
  const generatedForRef = (0, import_react.useRef)(null);
  const [candidates, setCandidates] = (0, import_react.useState)([]);
  const [index, setIndex] = (0, import_react.useState)(0);
  const [dismissed, setDismissed] = (0, import_react.useState)(false);
  const empty = draft.trim() === "";
  const finishedTurn = lastTurnComplete(outline) ? newestTurn(outline) : null;
  (0, import_react.useEffect)(() => {
    if (running || removed || dismissed || !empty) return;
    if (finishedTurn === null) return;
    if (generatedForRef.current === finishedTurn) return;
    generatedForRef.current = finishedTurn;
    const transcript = buildTranscript(outline);
    if (transcript.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const route = sessionRoute(ctx, sessionId);
    let live = true;
    void requestSuggestions(sessionId, transcript, route, controller.signal).then((result) => {
      if (!live) return;
      abortRef.current = null;
      setCandidates(result);
      setIndex(0);
    });
    return () => {
      live = false;
      controller.abort();
      abortRef.current = null;
    };
  }, [running, removed, dismissed, empty, finishedTurn, sessionId, ctx]);
  (0, import_react.useEffect)(() => {
    if (running) setDismissed(false);
  }, [running]);
  const position = candidates.length > 0 ? index % candidates.length : 0;
  const candidate = empty && !dismissed && candidates.length > 0 ? candidates[position] ?? null : null;
  const suggestion = candidate === null ? null : candidates.length > 1 ? String(position + 1) + "/" + String(candidates.length) + " \xB7 " + candidate : candidate;
  const accepted = candidate;
  (0, import_react.useEffect)(() => {
    const node = findPlaceholder(hostRef.current);
    if (suggestion !== null) {
      applySuggestion(node, suggestion);
      return;
    }
    const shellText = shellPlaceholderText(hostRef.current);
    if (shellText !== null) applySuggestion(node, shellText);
  });
  const cycle = (0, import_react.useCallback)((delta) => {
    setIndex((current) => (current + delta + candidates.length) % Math.max(1, candidates.length));
  }, [candidates.length]);
  const setDraftRef = (0, import_react.useRef)(inputActions.setDraft);
  (0, import_react.useEffect)(() => {
    setDraftRef.current = inputActions.setDraft;
  }, [inputActions]);
  (0, import_react.useEffect)(() => {
    if (suggestion === null) return;
    const onKeyDown = (event) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-placeholder]") === null) return;
      const verdict = decideKey(event, { visible: true, empty: true });
      if (verdict === "ignore") return;
      event.preventDefault();
      event.stopPropagation();
      if (verdict === "next") cycle(1);
      else if (verdict === "prev") cycle(-1);
      else if (verdict === "accept") {
        if (accepted !== null) setDraftRef.current(accepted);
      } else {
        setCandidates([]);
        setDismissed(true);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [suggestion, cycle]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { ref: hostRef, className: "dsh-suggest-host" });
}

// src/client/index.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var inject = ["slots", "sessions"];
function apply(ctx) {
  const entry = (props) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SuggestOverlay, { ctx, ...props });
  const seat = ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({
    name: "conversation.input.overlay",
    id: "suggest-next-prompt",
    order: 100
  }, entry));
  return () => {
    seat();
  };
}

		return module.exports;
	}
});
