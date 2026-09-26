// Lip-sync helpers: viseme timelines (from VOICEVOX mora timing or estimated from kana)
// and sampling them into a jaw-opening value.

// how far the fox's jaw opens for each mouth shape
export const OPEN = { a: 1.0, o: 0.8, e: 0.62, u: 0.42, i: 0.36, n: 0.14, m: 0.0, rest: 0.0 };

const SMALL = 'ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ';
const VOWEL_OF = (() => {
  const rows = {
    a: 'あかさたなはまやらわがざだばぱぁゃゎアカサタナハマヤラワガザダバパァャヮヵ',
    i: 'いきしちにひみりぎじぢびぴぃイキシチニヒミリギジヂビピィ',
    u: 'うくすつぬふむゆるぐずづぶぷぅゅゔウクスツヌフムユルグズヅブプゥュヴ',
    e: 'えけせてねへめれげぜでべぺぇエケセテネヘメレゲゼデベペェヶ',
    o: 'おこそとのほもよろをごぞどぼぽぉょオコソトノホモヨロヲゴゾドボポォョ',
  };
  const map = {};
  for (const [v, chars] of Object.entries(rows)) for (const ch of chars) map[ch] = v;
  return map;
})();
const BILABIAL = new Set('まみむめもばびぶべぼぱぴぷぺぽマミムメモバビブベボパピプペポ');
const PAUSE = { '、': 0.22, '，': 0.22, ',': 0.2, '。': 0.38, '．': 0.38, '！': 0.35, '!': 0.35, '？': 0.38, '?': 0.38, '…': 0.4, '‥': 0.3, '　': 0.12, ' ': 0.1 };

/**
 * Estimate a viseme timeline from a kana reading.
 * @param {string} kana  hiragana/katakana reading (kanji are skipped)
 * @param {number} mora  seconds per mora
 */
export function kanaTimeline(kana, mora = 0.13) {
  const out = [];
  let t = 0.05;
  const chars = [...(kana || '')];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (PAUSE[ch] !== undefined) {
      out.push({ t, d: PAUSE[ch], s: 'rest', w: 0 });
      t += PAUSE[ch];
      continue;
    }
    if (SMALL.includes(ch)) {
      // palatalised glide: modify the previous mora's vowel
      const prev = out[out.length - 1];
      if (prev && prev.s !== 'rest') prev.s = VOWEL_OF[ch] || prev.s;
      continue;
    }
    if (ch === 'っ' || ch === 'ッ') { out.push({ t, d: mora * 0.8, s: 'm', w: 1 }); t += mora * 0.8; continue; }
    if (ch === 'ん' || ch === 'ン') { out.push({ t, d: mora, s: 'n', w: 0.5 }); t += mora; continue; }
    if (ch === 'ー' || ch === '〜' || ch === '~') {
      const prev = out[out.length - 1];
      if (prev) { prev.d += mora; t += mora; }
      continue;
    }
    const v = VOWEL_OF[ch];
    if (!v) continue;   // unknown symbol (kanji, latin…) — skip
    if (BILABIAL.has(ch)) { out.push({ t, d: mora * 0.3, s: 'm', w: 1 }); t += mora * 0.3; out.push({ t, d: mora * 0.7, s: v, w: 1 }); t += mora * 0.7; }
    else { out.push({ t, d: mora, s: v, w: 1 }); t += mora; }
  }
  return out;
}

export function timelineDuration(tl) {
  if (!tl.length) return 0;
  const last = tl[tl.length - 1];
  return last.t + last.d;
}

/** Jaw opening (0..1) at time t, with a little co-articulation between segments. */
export function sampleTimeline(tl, t) {
  if (!tl.length || t < 0) return 0;
  // binary search
  let lo = 0, hi = tl.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tl[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  const seg = tl[lo];
  if (t > seg.t + seg.d) return 0;
  const k = (t - seg.t) / Math.max(seg.d, 1e-3);
  const cur = (OPEN[seg.s] ?? 0) * (seg.w ?? 1);
  const next = tl[lo + 1] ? (OPEN[tl[lo + 1].s] ?? 0) * (tl[lo + 1].w ?? 1) : 0;
  // open quickly, hold, then drift toward the next shape
  const attack = Math.min(1, k / 0.3);
  const blend = k > 0.7 ? (k - 0.7) / 0.3 : 0;
  return cur * attack * (1 - blend * 0.5) + next * blend * 0.5;
}
