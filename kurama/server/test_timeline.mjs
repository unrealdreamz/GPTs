// Unit tests for the VOICEVOX lip-sync timeline builder.
// Run: node server/test_timeline.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTimeline, wavDuration } from "./voicevox.mjs";

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const mora = (text, consonant, consonant_length, vowel, vowel_length) => ({
  text, consonant, consonant_length, vowel, vowel_length, pitch: 5.5,
});

// Handcrafted audio_query: 「バンッス、カミエ」 with a bilabial (b, m), a plain
// consonant (s, k), a devoiced vowel (U), N, cl, an inline pau and a pause_mora.
const FIXTURE = {
  accent_phrases: [
    {
      moras: [
        mora("バ", "b", 0.05, "a", 0.1),
        mora("ン", null, null, "N", 0.08),
        mora("ッ", null, null, "cl", 0.06),
        mora("ス", "s", 0.07, "U", 0.04),
      ],
      accent: 1,
      pause_mora: mora("、", null, null, "pau", 0.3),
      is_interrogative: false,
    },
    {
      moras: [
        mora("カ", "k", 0.06, "a", 0.12),
        mora("ミ", "m", 0.05, "i", 0.09),
        mora("エ", null, null, "e", 0.1),
        mora("、", null, null, "pau", 0.02),
      ],
      accent: 2,
      pause_mora: null,
      is_interrogative: false,
    },
  ],
  speedScale: 1.25,
  pitchScale: -0.06,
  intonationScale: 1.15,
  volumeScale: 1,
  prePhonemeLength: 0.1,
  postPhonemeLength: 0.2,
  pauseLength: null,
  pauseLengthScale: 1,
  outputSamplingRate: 24000,
  outputStereo: false,
};

test("handcrafted query → expected segments, scaled by speedScale", () => {
  const tl = buildTimeline(FIXTURE);
  const expected = [
    ["m", 1, 0.05], // b: bilabial closure
    ["a", 1, 0.1],
    ["n", 0.4, 0.08], // N
    ["m", 1, 0.06], // cl: closed
    ["u", 0.5, 0.07], // s: consonant takes the (devoiced) vowel's shape
    ["u", 0.35, 0.04], // U: devoiced
    ["rest", 0, 0.3], // pause_mora
    ["a", 0.5, 0.06], // k
    ["a", 1, 0.12],
    ["m", 1, 0.05], // m: bilabial
    ["i", 1, 0.09],
    ["e", 1, 0.1],
    ["rest", 0, 0.02], // inline pau mora
    ["rest", 0, 0.2], // postPhonemeLength
  ];
  assert.equal(tl.length, expected.length);
  let t = 0.1 / 1.25; // starts at prePhonemeLength
  tl.forEach((seg, i) => {
    const [s, w, d] = expected[i];
    assert.equal(seg.s, s, `segment ${i} shape`);
    assert.equal(seg.w, w, `segment ${i} weight`);
    close(seg.d, d / 1.25);
    close(seg.t, t);
    t += d / 1.25;
  });
  const end = tl.at(-1).t + tl.at(-1).d;
  close(end, (0.1 + 1.32 + 0.02) / 1.25);
});

test("pauseLength / pauseLengthScale override pause durations like the engine", () => {
  const tl = buildTimeline({ ...FIXTURE, speedScale: 1, pauseLength: 0.5, pauseLengthScale: 2 });
  const rests = tl.filter((s) => s.s === "rest").map((s) => s.d);
  assert.deepEqual(rests, [1, 1, 0.2]); // pause_mora, inline pau, post
});

test("zero-length and missing fields are skipped, output keys are exact", () => {
  const tl = buildTimeline({
    accent_phrases: [{ moras: [mora("ア", null, null, "a", 0), mora("イ", "", 0, "i", 0.1)] }],
    speedScale: 1,
    prePhonemeLength: 0,
    postPhonemeLength: 0,
  });
  assert.deepEqual(tl, [{ t: 0, d: 0.1, s: "i", w: 1 }]);
  assert.deepEqual(buildTimeline({}), []);
});

test("real VOICEVOX 0.25.2 audio_query fixture: contiguous, valid, ends at pre+moras+post", () => {
  const q = JSON.parse(readFileSync(new URL("./fixtures/sample_query.json", import.meta.url), "utf8"));
  const tl = buildTimeline(q);
  const shapes = new Set(["a", "i", "u", "e", "o", "n", "m", "rest"]);
  let raw = q.prePhonemeLength + q.postPhonemeLength;
  for (const ap of q.accent_phrases) {
    for (const m of ap.moras) raw += (m.consonant_length || 0) + m.vowel_length;
    if (ap.pause_mora) raw += ap.pause_mora.vowel_length;
  }
  close(tl[0].t, q.prePhonemeLength / q.speedScale);
  for (let i = 0; i < tl.length; i++) {
    assert.ok(shapes.has(tl[i].s), `bad shape ${tl[i].s}`);
    assert.ok(tl[i].w >= 0 && tl[i].w <= 1);
    if (i) close(tl[i].t, tl[i - 1].t + tl[i - 1].d, 2e-4);
  }
  close(tl.at(-1).t + tl.at(-1).d, raw / q.speedScale);
  assert.ok(tl.some((s) => s.s === "u" && s.w === 0.35), "devoiced U from the engine");
  assert.ok(tl.some((s) => s.s === "rest" && s.d > 0.25), "pause_mora from 「、」/「…」");
});

test("wavDuration reads the RIFF header", () => {
  const dataBytes = 48_000; // 1 s of 24 kHz mono 16-bit
  const b = Buffer.alloc(44 + dataBytes);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // channels
  b.writeUInt32LE(24_000, 24);
  b.writeUInt32LE(48_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(dataBytes, 40);
  close(wavDuration(b), 1);
  assert.throws(() => wavDuration(Buffer.from("nope")));
});
