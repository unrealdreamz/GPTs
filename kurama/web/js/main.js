// Entry point: builds the stage, wires the conversation loop, runs the render loop.
import * as THREE from 'three';
import { createStage } from './scene.js';
import { Kurama } from './kurama.js';
import { Voice } from './voice.js';
import { Conversation, fetchStatus } from './chat.js';
import { Subtitles, toast, setThinking, setBond, renderLog, setChips, bindSettings, Mic } from './ui.js';

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const conv = new Conversation();
const voice = new Voice(conv.settings);
const subs = new Subtitles();
subs.setMode(conv.settings.subs);
setBond(conv.profile.bond);
renderLog(conv.log);

const HOSTILE = new Set(['angry', 'furious', 'annoyed']);
const IDLE_SLEEP_MS = 120_000;

let stage = null;
let kurama = null;
let status = null;
let busy = false;
let entered = false;
let lastActivity = performance.now();
let queued = null;

// camera rig
const cam = {
  far: new THREE.Vector3(0, 3.4, 27),
  near: new THREE.Vector3(0, 2.5, 15.5),
  pos: new THREE.Vector3(0, 3.4, 27),
  target: new THREE.Vector3(0, 4.1, 2.2),
  look: new THREE.Vector3(0, 4.1, 2.2),
  pointer: new THREE.Vector2(),
  dolly: 0,          // 0 far → 1 near
};

// ---------------------------------------------------------------- boot

async function boot() {
  const introStatus = $('#intro-status');
  const enter = $('#intro-enter');
  $('#intro-name').value = conv.profile.name;
  for (const r of document.querySelectorAll('input[name="intro-era"]')) r.checked = r.value === conv.profile.era;

  status = await fetchStatus();
  setChips(status, status?.voicevox?.ok);
  try {
    stage = await createStage($('#scene'), (p) => { introStatus.textContent = `Summoning… ${Math.round(p * 100)}%`; });
  } catch (err) {
    console.error(err);
    introStatus.textContent = 'Could not start WebGL or load the model. Is the server running (npm start)?';
    return;
  }
  kurama = new Kurama(stage);
  window.__kurama = { stage, kurama, voice, conv, cam };   // handy for tinkering in the devtools console
  applyEra();
  requestAnimationFrame(frame);

  const mode = status?.claude?.mode;
  const voiceTxt = status?.voicevox?.ok ? 'VOICEVOX voice ready' : 'VOICEVOX not found — browser voice';
  introStatus.textContent = `${mode === 'live' ? 'Claude connected' : 'Demo mode (no API key)'} · ${voiceTxt}`;
  enter.disabled = false;
  enter.textContent = 'Enter the seal';

  $('#intro-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (entered) return;
    entered = true;
    const newName = $('#intro-name').value.trim();
    const newEra = document.querySelector('input[name="intro-era"]:checked')?.value || 'caged';
    if (newEra !== conv.profile.era && conv.history.length) conv.reset();
    if (conv.isNew) conv.profile.bond = newEra === 'partner' ? 50 : 0;
    conv.profile.name = newName;
    conv.profile.era = newEra;
    conv.save();
    setBond(conv.profile.bond);
    applyEra();
    await voice.unlock();
    $('#intro').classList.add('gone');
    setTimeout(() => $('#intro').remove(), 1400);
    bindUi();
    await sleep(1600);
    greet();
  });
}

function applyEra() {
  if (!stage) return;
  const partner = conv.profile.era === 'partner';
  const { setParts } = stage;
  // after the war the cage is gone: Kurama and his host meet in the open
  for (const n of ['CageBars', 'SealTag']) if (setParts[n]) setParts[n].visible = !partner;
  stage.scene.fog.color.set(partner ? 0x0c1616 : 0x071113);
  stage.hostLight.intensity = partner ? 12 : 6;
}

// ---------------------------------------------------------------- ui

function bindUi() {
  const input = $('#msg');
  $('#chat').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    talk(text);
  });
  addEventListener('keydown', (e) => {
    if (e.target === input || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length === 1 && !document.querySelector('.panel:not([hidden])')) input.focus();
  });
  new Mic($('#btn-mic'), () => conv.settings.mic, (text) => { input.value = ''; talk(text); }, (t) => { input.value = t; });

  bindSettings(conv, (what) => {
    voice.apply();
    if (what === 'subs') subs.setMode(conv.settings.subs);
    if (what === 'era') { applyEra(); toast(conv.profile.era === 'partner' ? 'Era: Partner — the cage is gone.' : 'Era: Caged — the seal holds.'); }
    if (what === 'voice' && conv.settings.voice === 'voicevox' && !status?.voicevox?.ok) toast('VOICEVOX engine not detected on 127.0.0.1:50021');
    if (what === 'reset') {
      voice.stop();
      conv.reset();
      renderLog(conv.log);
      setBond(conv.profile.bond);
      toast('Kurama has forgotten everything… for now.');
      greet();
    }
  });

  addEventListener('pointermove', (e) => {
    cam.pointer.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
  });
}

// ---------------------------------------------------------------- conversation

function greet() {
  const first = conv.isNew;
  const text = first
    ? '(The host walks down the flooded corridor for the first time and stops in front of the cage.)'
    : '(The host comes back to the cage after being away for a while.)';
  talk(text, { stage: true });
}

async function talk(text, { stage: isStage = false } = {}) {
  lastActivity = performance.now();
  if (busy) {
    // interrupt: stop talking, answer the newest message
    queued = { text, isStage };
    voice.stop();
    return;
  }
  busy = true;
  voice.stop();
  setThinking(true);
  try {
    const waking = kurama.asleep ? kurama.wake() : null;
    const [reply] = await Promise.all([conv.send(text, { stage: isStage }), waking]);
    setThinking(false);
    renderLog(conv.log);
    if (reply.error) console.warn('[kurama]', reply.error);
    await perform(reply);
    const d = reply.bondAfter - reply.bondBefore;
    setBond(conv.profile.bond, d);
    milestone(reply.bondBefore, reply.bondAfter);
  } catch (err) {
    console.error(err);
    setThinking(false);
    toast('The seal is silent… (could not reach the server)');
  } finally {
    busy = false;
    lastActivity = performance.now();
    if (queued) {
      const q = queued;
      queued = null;
      talk(q.text, { stage: q.isStage });
    }
  }
}

async function perform(reply) {
  kurama.setEmotion(reply.emotion);
  kurama.setBase(HOSTILE.has(reply.emotion) ? 'Angry' : 'Talk');
  if (reply.gesture === 'roar') {
    kurama.playGesture('roar');
    voice.roar();
    flash();
    await sleep(2300);
  }
  await voice.speak(reply, {
    onStart: (dur) => {
      subs.show(reply.ja, reply.en, dur);
      if (reply.gesture && reply.gesture !== 'none' && reply.gesture !== 'roar') kurama.playGesture(reply.gesture);
    },
  });
  kurama.setMouth(0);
  kurama.setBase(HOSTILE.has(reply.emotion) ? 'Angry' : 'Idle');
  subs.hideAfter(3800);
  setTimeout(() => {
    if (!busy) { kurama.setEmotion('neutral'); kurama.setBase('Idle'); }
  }, 5000);
}

function milestone(before, after) {
  const era = conv.profile.era;
  if (era === 'caged' && before < 50 && after >= 50) toast('Kurama is starting to respect you…');
  if (era === 'caged' && before < 100 && after >= 100) toast('Kurama acknowledges you. (Try the Partner era in Settings.)', 5000);
  if (era === 'partner' && before < 100 && after >= 100) toast('Your bond with Kurama is complete.', 4000);
}

function flash() {
  const f = $('#flash');
  f.classList.add('on');
  setTimeout(() => f.classList.remove('on'), 1200);
}

// ---------------------------------------------------------------- frame

const timer = new THREE.Timer();
const headPos = new THREE.Vector3();

function frame() {
  requestAnimationFrame(frame);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  const t = timer.getElapsed();
  const { scene, camera, shared, motes, water, chakraLight, eyeGlows, outline } = stage;

  kurama.setMouth(voice.mouth());
  const st = kurama.update(dt, camera);

  // doze off when ignored
  if (entered && !busy && !kurama.asleep && performance.now() - lastActivity > IDLE_SLEEP_MS) kurama.sleep();

  // camera: dolly in after entering, pointer parallax, breathing sway, roar shake
  cam.dolly += ((entered ? 1 : 0) - cam.dolly) * (1 - Math.exp(-0.9 * dt));
  const e = cam.dolly * cam.dolly * (3 - 2 * cam.dolly);
  cam.pos.lerpVectors(cam.far, cam.near, e);
  cam.pos.x += cam.pointer.x * 0.9 + Math.sin(t * 0.21) * 0.15;
  cam.pos.y += -cam.pointer.y * 0.45 + Math.sin(t * 0.33) * 0.06;
  const shake = kurama.shake * 0.12;
  camera.position.set(
    cam.pos.x + (Math.random() - 0.5) * shake,
    cam.pos.y + (Math.random() - 0.5) * shake,
    cam.pos.z,
  );
  const head = kurama.bones.head;
  if (head) head.getWorldPosition(headPos);
  cam.target.set(headPos.x * 0.5, 3.4 + headPos.y * 0.2, 2.2);
  cam.look.lerp(cam.target, 1 - Math.exp(-2 * dt));
  camera.lookAt(cam.look);

  // chakra visuals
  const c = st.chakra;
  shared.rim.value = 0.1 + 0.5 * c;
  motes.material.uniforms.time.value = t;
  motes.material.uniforms.intensity.value = c;
  chakraLight.intensity = (8 + 30 * c) * (0.9 + 0.1 * Math.sin(t * 7.3) * Math.sin(t * 3.1));
  if (water) {
    water.material.uniforms.time.value = t;
    water.material.uniforms.glow.value = 0.4 + c;
  }
  const open = kurama.eyeOpenness();
  for (const g of eyeGlows) {
    g.material.opacity = open * (0.55 + 0.35 * c) * (0.9 + 0.1 * Math.sin(t * 5));
  }
  voice.breathe(Math.max(0, Math.sin(t * Math.PI * 2 / 4)) * (kurama.asleep ? 1 : 0.5));

  outline.render(scene, camera);
}

boot();
