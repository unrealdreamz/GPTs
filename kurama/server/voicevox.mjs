// VOICEVOX client + lip-sync timeline builder.
//
// Flow per utterance: resolve the speaker/style by NAME from /speakers,
// POST /initialize_speaker once per style, POST /audio_query, tweak the query,
// POST /synthesis with that same query, and build the viseme timeline from it.

const DEFAULT_URL = "http://127.0.0.1:50021";
const DEFAULT_SPEAKER = "青山龍星";
const CALL_TIMEOUT_MS = 15_000;
const SPEAKERS_TTL_MS = 60_000;
const SPEAKERS_FAIL_TTL_MS = 5_000;

// Emotion → style names, in order of preference. Resolved by name against the
// engine's /speakers list; if none are present the speaker's first style wins.
export const EMOTION_STYLES = Object.freeze({
  neutral: ["ノーマル"],
  amused: ["喜び", "ノーマル"],
  smug: ["ノーマル"],
  surprised: ["ノーマル", "喜び"],
  annoyed: ["不機嫌", "ノーマル"],
  angry: ["不機嫌", "熱血", "ノーマル"],
  furious: ["熱血", "不機嫌", "ノーマル"],
  caring: ["しっとり", "ノーマル"],
  sad: ["かなしみ", "しっとり", "ノーマル"],
  thoughtful: ["しっとり", "ノーマル"],
  sleepy: ["囁き", "しっとり", "ノーマル"],
});

export const VOICE_DEFAULTS = Object.freeze({
  speedScale: 1.0,
  pitchScale: -0.06,
  intonationScale: 1.15,
  volumeScale: 1.0,
  prePhonemeLength: 0.08,
  postPhonemeLength: 0.2,
});

export class VoicevoxUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "VoicevoxUnavailableError";
  }
}

export function voicevoxConfig() {
  const url = (process.env.VOICEVOX_URL || DEFAULT_URL).replace(/\/+$/, "");
  const speakerName = process.env.VOICEVOX_SPEAKER || DEFAULT_SPEAKER;
  const forced = process.env.VOICEVOX_STYLE_ID;
  const forcedStyleId = forced != null && forced !== "" && Number.isInteger(Number(forced)) ? Number(forced) : null;
  return { url, speakerName, forcedStyleId };
}

async function vvFetch(path, { method = "GET", body, headers, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  const { url } = voicevoxConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url + path, { method, body, headers, signal: ctrl.signal });
  } catch (err) {
    const why = err?.name === "AbortError" ? `timed out after ${timeoutMs} ms` : err?.cause?.code || err?.message;
    throw new VoicevoxUnavailableError(`VOICEVOX ${method} ${path} failed: ${why}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(`VOICEVOX ${method} ${path} → HTTP ${res.status} ${detail.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// --- speakers / styles -------------------------------------------------------

let speakersCache = { at: 0, url: null, ok: false, data: null, error: null };
const initializedStyles = new Set();

/** GET /speakers, cached for 60 s (5 s for failures). Never throws. */
export async function getSpeakers({ timeoutMs = CALL_TIMEOUT_MS, force = false } = {}) {
  const { url } = voicevoxConfig();
  const ttl = speakersCache.ok ? SPEAKERS_TTL_MS : SPEAKERS_FAIL_TTL_MS;
  if (!force && speakersCache.url === url && Date.now() - speakersCache.at < ttl) return speakersCache;
  try {
    const res = await vvFetch("/speakers", { timeoutMs });
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("unexpected /speakers payload");
    speakersCache = { at: Date.now(), url, ok: true, data, error: null };
  } catch (err) {
    // Engine gone (or restarted): re-initialize styles once it's back.
    initializedStyles.clear();
    speakersCache = { at: Date.now(), url, ok: false, data: null, error: err.message };
  }
  return speakersCache;
}

const talkStyles = (speaker) =>
  (speaker?.styles ?? []).filter((s) => Number.isInteger(s?.id) && (s.type == null || s.type === "talk"));

/** Pick the configured speaker (by name), else the first speaker with talk styles. */
export function pickSpeaker(speakers, name = voicevoxConfig().speakerName) {
  if (!Array.isArray(speakers) || !speakers.length) return null;
  return (
    speakers.find((s) => s?.name === name && talkStyles(s).length) ||
    speakers.find((s) => talkStyles(s).length) ||
    null
  );
}

/** Style id for an emotion, resolved by style name on the given speaker. */
export function styleIdFor(speaker, emotion) {
  const styles = talkStyles(speaker);
  if (!styles.length) return null;
  for (const wanted of EMOTION_STYLES[emotion] ?? EMOTION_STYLES.neutral) {
    const hit = styles.find((s) => s.name === wanted);
    if (hit) return hit.id;
  }
  return styles[0].id;
}

/** Summary for /api/status. */
export async function voicevoxStatus({ timeoutMs = 4_000 } = {}) {
  const { url } = voicevoxConfig();
  const cache = await getSpeakers({ timeoutMs });
  if (!cache.ok) return { ok: false, url, speaker: null, styles: [] };
  const speaker = pickSpeaker(cache.data);
  return {
    ok: Boolean(speaker),
    url,
    speaker: speaker?.name ?? null,
    styles: talkStyles(speaker).map((s) => ({ name: s.name, id: s.id })),
  };
}

// --- timeline ----------------------------------------------------------------

const BILABIALS = new Set(["m", "my", "b", "by", "p", "py"]);
const VOWELS = new Set(["a", "i", "u", "e", "o"]);
const round4 = (x) => Math.round(x * 10_000) / 10_000;

function vowelShape(vowel) {
  if (!vowel) return "rest";
  const v = String(vowel);
  if (VOWELS.has(v)) return v;
  if (VOWELS.has(v.toLowerCase())) return v.toLowerCase(); // devoiced A/I/U/E/O
  if (v === "N") return "n";
  if (v === "cl") return "m";
  return "rest"; // pau and anything unknown
}

function vowelWeight(vowel) {
  const v = String(vowel ?? "");
  if (VOWELS.has(v)) return 1;
  if (VOWELS.has(v.toLowerCase())) return 0.35; // devoiced
  if (v === "N") return 0.4;
  if (v === "cl") return 1; // closed lips for the glottal stop
  return 0; // pau / rest
}

/**
 * Build the lip-sync timeline from the exact audio_query that gets synthesized.
 * Returns [{ t, d, s, w }] where t/d are seconds in the output audio.
 *
 * - starts at prePhonemeLength (leading silence is implicit, no segment)
 * - per mora: optional consonant segment ("m" w=1 for bilabial closure,
 *   otherwise the mora's vowel shape at w=0.5), then the vowel segment
 * - pause_mora → "rest"; a trailing "rest" covers postPhonemeLength
 * - pauses honour pauseLength / pauseLengthScale like the engine does
 * - every duration is divided by speedScale (the engine scales them all)
 */
export function buildTimeline(query) {
  const q = query ?? {};
  const speed = Number(q.speedScale) > 0 ? Number(q.speedScale) : 1;
  const pauseLength = q.pauseLength == null ? null : Number(q.pauseLength);
  const pauseScale = Number.isFinite(Number(q.pauseLengthScale)) && q.pauseLengthScale != null ? Number(q.pauseLengthScale) : 1;
  const out = [];
  let t = (Number(q.prePhonemeLength) || 0) / speed;

  const push = (s, w, rawLen) => {
    const d = (Number(rawLen) || 0) / speed;
    if (!(d > 0)) return;
    out.push({ t: round4(t), d: round4(d), s, w });
    t += d;
  };

  for (const phrase of q.accent_phrases ?? []) {
    for (const mora of phrase?.moras ?? []) {
      const shape = vowelShape(mora.vowel);
      if (mora.consonant && mora.consonant_length) {
        if (BILABIALS.has(mora.consonant)) push("m", 1, mora.consonant_length);
        else push(shape, 0.5, mora.consonant_length);
      }
      if (mora.vowel === "pau") {
        push("rest", 0, (pauseLength ?? Number(mora.vowel_length ?? 0)) * pauseScale);
      } else {
        push(shape, vowelWeight(mora.vowel), mora.vowel_length);
      }
    }
    const pause = phrase?.pause_mora;
    if (pause) {
      const len = (pauseLength ?? Number(pause.vowel_length ?? 0)) * pauseScale;
      push("rest", 0, len);
    }
  }
  push("rest", 0, Number(q.postPhonemeLength) || 0);
  return out;
}

// --- WAV ---------------------------------------------------------------------

/** Duration in seconds from a RIFF/WAVE header: dataBytes / (rate * channels * bytesPerSample). */
export function wavDuration(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE buffer");
  }
  let off = 12;
  let fmt = null;
  let dataBytes = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "fmt ") {
      fmt = { channels: b.readUInt16LE(off + 10), sampleRate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    } else if (id === "data") {
      dataBytes = Math.min(size, b.length - (off + 8));
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || dataBytes == null) throw new Error("WAV missing fmt or data chunk");
  const bytesPerSample = Math.max(1, Math.ceil(fmt.bits / 8));
  return dataBytes / (fmt.sampleRate * fmt.channels * bytesPerSample);
}

// --- synthesis ---------------------------------------------------------------

async function ensureInitialized(styleId) {
  if (initializedStyles.has(styleId)) return;
  initializedStyles.add(styleId);
  try {
    await vvFetch(`/initialize_speaker?speaker=${styleId}&skip_reinit=true`, { method: "POST" });
  } catch (err) {
    console.warn(`[voicevox] initialize_speaker ${styleId} failed (ignored): ${err.message}`);
  }
}

const finiteOr = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/**
 * Synthesize `text` in the style matching `emotion`.
 * Throws VoicevoxUnavailableError when the engine can't be reached.
 */
export async function synthesize({ text, emotion = "neutral", speedScale, pitchScale, intonationScale }) {
  const cache = await getSpeakers();
  if (!cache.ok) throw new VoicevoxUnavailableError(cache.error || "VOICEVOX /speakers unavailable");
  const { forcedStyleId } = voicevoxConfig();
  const owner = forcedStyleId == null ? null : cache.data.find((s) => s?.styles?.some((st) => st.id === forcedStyleId));
  const speaker = owner ?? pickSpeaker(cache.data);
  if (!speaker) throw new VoicevoxUnavailableError("VOICEVOX reports no usable speakers");
  const styleId = forcedStyleId ?? styleIdFor(speaker, emotion);
  await ensureInitialized(styleId);

  const qRes = await vvFetch(`/audio_query?text=${encodeURIComponent(text)}&speaker=${styleId}`, { method: "POST" });
  const query = await qRes.json();
  Object.assign(query, {
    speedScale: Math.min(2, Math.max(0.5, finiteOr(speedScale, VOICE_DEFAULTS.speedScale))),
    pitchScale: Math.min(0.15, Math.max(-0.15, finiteOr(pitchScale, VOICE_DEFAULTS.pitchScale))),
    intonationScale: Math.min(2, Math.max(0, finiteOr(intonationScale, VOICE_DEFAULTS.intonationScale))),
    volumeScale: VOICE_DEFAULTS.volumeScale,
    prePhonemeLength: VOICE_DEFAULTS.prePhonemeLength,
    postPhonemeLength: VOICE_DEFAULTS.postPhonemeLength,
  });

  const sRes = await vvFetch(`/synthesis?speaker=${styleId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "audio/wav" },
    body: JSON.stringify(query),
  });
  const wav = Buffer.from(await sRes.arrayBuffer());

  return {
    engine: "voicevox",
    speaker: speaker.name,
    styleId,
    audio: wav.toString("base64"),
    duration: round4(wavDuration(wav)),
    timeline: buildTimeline(query),
  };
}
