// Kurama mindscape server: static front-end, /vendor/three, and the chat/TTS API.
// Node built-in http only.

import http from "node:http";
import { createReadStream, readFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

import {
  EMOTIONS,
  REPLY_SCHEMA,
  SYSTEM_PROMPT,
  buildContextPrefix,
  hasKanji,
  normalizeProfile,
  normalizeReply,
} from "./persona.mjs";
import { demoReply, refusalReply, silenceReply, troubleReply } from "./demo.mjs";
import { VoicevoxUnavailableError, synthesize, voicevoxStatus } from "./voicevox.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB_ROOT = path.join(ROOT, "web");
const THREE_ROOT = path.join(ROOT, "node_modules", "three");

// --- .env (optional, tiny loader; real env vars win) -------------------------

function loadDotEnv(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    // Skip empty values: an empty ANTHROPIC_API_KEY would shadow other credential sources.
    if (value !== "" && process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "127.0.0.1";
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const HISTORY_LIMIT = 40;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TTS_CHARS = 400;
const MAX_BODY_BYTES = 1_000_000;

// --- Claude ------------------------------------------------------------------

const hasEnvCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const forceDemo = process.env.KURAMA_DEMO === "1";

const claude = {
  mode: hasEnvCredentials && !forceDemo ? "live" : "demo",
  // No env credentials: optionally try live once (e.g. an `ant auth login` profile).
  tryLiveOnce: !hasEnvCredentials && !forceDemo && process.env.KURAMA_TRY_LIVE === "1",
  reason: forceDemo ? "KURAMA_DEMO=1" : hasEnvCredentials ? null : "no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN",
};

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

function switchToDemo(reason) {
  if (claude.mode !== "demo") console.warn(`[claude] switching to demo mode: ${reason}`);
  claude.mode = "demo";
  claude.reason = reason;
}

// Server-side refusal fallbacks are offered for the Opus 5 / Fable 5 families; other models
// (e.g. CLAUDE_MODEL=claude-sonnet-5) get the same request without them.
const USE_FALLBACKS = /^claude-(opus-5|fable-5)/.test(MODEL) && process.env.KURAMA_FALLBACKS !== "0";

async function callClaude(messages) {
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    ...(USE_FALLBACKS ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "low", format: { type: "json_schema", schema: REPLY_SCHEMA } },
    messages,
  });
  return response;
}

/**
 * Keep valid user/assistant string turns, merge consecutive same-role turns,
 * keep the last HISTORY_LIMIT, and make sure it starts and ends on a user turn
 * (a trailing assistant turn would be a prefill, which this model rejects).
 */
function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const merged = [];
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") continue;
    const content = m.content.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!content) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${content}`;
    else merged.push({ role: m.role, content });
  }
  const trimmed = merged.slice(-HISTORY_LIMIT);
  while (trimmed.length && trimmed[0].role !== "user") trimmed.shift();
  while (trimmed.length && trimmed[trimmed.length - 1].role !== "user") trimmed.pop();
  return trimmed;
}

/** Per-profile context rides in the newest user turn, never in the cached system prompt. */
function withContext(history, profile) {
  const prefix = buildContextPrefix(profile);
  return history.map((m, i) =>
    i === history.length - 1 ? { role: "user", content: `${prefix}\n${m.content}` } : { role: m.role, content: m.content },
  );
}

function finish(reply, mode, error) {
  const r = normalizeReply(reply);
  const out = { ...r, raw: JSON.stringify(r), mode };
  if (error) out.error = error;
  return out;
}

async function handleChat(body) {
  const profile = normalizeProfile(body?.profile);
  const history = normalizeHistory(body?.messages);
  if (!history.length) return finish(silenceReply(), claude.mode, "request has no user message");

  let trial = false;
  if (claude.mode !== "live") {
    if (!claude.tryLiveOnce) return finish(demoReply(history, profile), "demo");
    claude.tryLiveOnce = false;
    trial = true;
  }

  const started = Date.now();
  let response;
  try {
    response = await callClaude(withContext(history, profile));
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error(`[claude] request failed: ${err.constructor.name} ${err.status ?? ""} ${err.message}`);
    } else {
      console.error(`[claude] request failed:`, err);
    }
    if (err instanceof Anthropic.AuthenticationError) {
      switchToDemo(`authentication failed (${err.status})`);
      return finish(demoReply(history, profile), "demo", `claude authentication failed; switched to demo mode`);
    }
    if (!(err instanceof Anthropic.APIError)) {
      // Thrown before any HTTP exchange: the SDK could not resolve credentials.
      switchToDemo(`no usable credentials: ${err.message}`);
      return finish(demoReply(history, profile), "demo", `claude credentials unavailable; switched to demo mode`);
    }
    if (err instanceof Anthropic.APIConnectionError) {
      // Couldn't reach the API. A one-shot trial stays in demo; live stays live.
      const mode = trial ? "demo" : "live";
      return finish(trial ? demoReply(history, profile) : troubleReply(profile), mode, `claude connection error: ${err.message}`);
    }
    // The API answered, so the credentials work: a trial run promotes to live.
    if (trial) {
      claude.mode = "live";
      claude.reason = null;
    }
    const label = err instanceof Anthropic.RateLimitError ? "claude rate limited" : `claude API error ${err.status ?? ""}`.trim();
    return finish(troubleReply(profile), "live", `${label}: ${err.message}`);
  }

  if (trial) {
    claude.mode = "live";
    claude.reason = null;
    console.log(`[claude] trial request succeeded; live mode enabled`);
  }

  const u = response.usage ?? {};
  console.log(
    `[claude] ${response.model} stop=${response.stop_reason} ${Date.now() - started}ms ` +
      `in=${u.input_tokens ?? "?"} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens ?? "?"}`,
  );

  if (response.stop_reason === "refusal") {
    console.warn(`[claude] refusal: ${JSON.stringify(response.stop_details ?? null)}`);
    return finish(refusalReply(profile), "live");
  }

  const block = response.content.find((b) => b.type === "text");
  try {
    if (!block) throw new Error(`no text block in response (stop_reason=${response.stop_reason})`);
    const reply = normalizeReply(JSON.parse(block.text));
    if (hasKanji(reply.kana)) console.warn(`[claude] kana still contains kanji: ${reply.kana}`);
    return finish(reply, "live");
  } catch (err) {
    console.error(`[claude] unusable reply (stop_reason=${response.stop_reason}):`, err.message, block?.text?.slice(0, 500));
    return finish(troubleReply(profile), "live", `could not parse Kurama's reply: ${err.message}`);
  }
}

// --- TTS ---------------------------------------------------------------------

async function handleTts(body, res) {
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, MAX_TTS_CHARS) : "";
  if (!text) return sendJson(res, 400, { error: "text is required" });
  const emotion = EMOTIONS.includes(body.emotion) ? body.emotion : "neutral";
  try {
    const result = await synthesize({
      text,
      emotion,
      speedScale: body.speedScale,
      pitchScale: body.pitchScale,
      intonationScale: body.intonationScale,
    });
    return sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof VoicevoxUnavailableError) {
      console.warn(`[voicevox] unavailable: ${err.message}`);
      return sendJson(res, 503, { error: "voicevox unavailable" });
    }
    console.error(`[voicevox] synthesis failed:`, err);
    return sendJson(res, 502, { error: `voicevox error: ${err.message}` });
  }
}

// --- status ------------------------------------------------------------------

async function handleStatus(res) {
  const voicevox = await voicevoxStatus();
  return sendJson(res, 200, { claude: { mode: claude.mode, model: MODEL }, voicevox });
}

// --- HTTP plumbing -----------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ktx2": "image/ktx2",
  ".hdr": "application/octet-stream",
  ".exr": "application/octet-stream",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/** Map a URL path under `root` to a file path, refusing traversal and dotfiles. */
function resolveUnder(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const segments = decoded.split(/[\\/]+/).filter(Boolean);
  if (segments.some((s) => s === ".." || s.startsWith("."))) return null;
  const full = path.resolve(root, ...segments);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

async function serveFile(req, res, root, urlPath) {
  const file = resolveUnder(root, urlPath);
  if (!file) return sendText(res, 404, "Not found");
  try {
    let target = file;
    let info = await stat(target);
    if (info.isDirectory()) {
      target = path.join(target, "index.html");
      info = await stat(target);
    }
    if (!info.isFile()) return sendText(res, 404, "Not found");
    // Symlinks must not lead outside the served root.
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return sendText(res, 404, "Not found");

    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(target)
      .on("error", (err) => {
        console.error(`[static] read failed ${target}:`, err.message);
        res.destroy(err);
      })
      .pipe(res);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return sendText(res, 404, "Not found");
    console.error(`[static] ${urlPath}:`, err);
    return sendText(res, 500, "Internal error");
  }
}

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;

  if (pathname.startsWith("/api/")) {
    if (pathname === "/api/status") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      return handleStatus(res);
    }
    if (pathname === "/api/chat") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        return sendJson(res, 200, finish(silenceReply(), claude.mode, err.message));
      }
      try {
        return sendJson(res, 200, await handleChat(body));
      } catch (err) {
        console.error(`[chat] unexpected failure:`, err);
        return sendJson(res, 200, finish(troubleReply(body?.profile), claude.mode, `server error: ${err.message}`));
      }
    }
    if (pathname === "/api/tts") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message });
      }
      return handleTts(body, res);
    }
    return sendJson(res, 404, { error: "not found" });
  }

  if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "Method not allowed");
  if (pathname === "/vendor/three" || pathname.startsWith("/vendor/three/")) {
    return serveFile(req, res, THREE_ROOT, pathname.slice("/vendor/three".length));
  }
  return serveFile(req, res, WEB_ROOT, pathname);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  res.on("finish", () => {
    if (req.url.startsWith("/api/")) console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
  });
  route(req, res).catch((err) => {
    console.error(`[http] ${req.method} ${req.url}:`, err);
    if (!res.headersSent) sendText(res, 500, "Internal error");
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Kurama mindscape listening on http://${HOST}:${PORT}`);
  console.log(
    `[claude] mode=${claude.mode} model=${MODEL}` +
      (claude.reason ? ` (${claude.reason}${claude.tryLiveOnce ? "; KURAMA_TRY_LIVE=1: will try live once" : ""})` : ""),
  );
  voicevoxStatus().then((v) =>
    console.log(
      v.ok
        ? `[voicevox] ${v.url} speaker=${v.speaker} styles=${v.styles.map((s) => `${s.name}:${s.id}`).join(", ")}`
        : `[voicevox] not reachable at ${v.url} (TTS will return 503; front-end falls back to speechSynthesis)`,
    ),
  );
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
