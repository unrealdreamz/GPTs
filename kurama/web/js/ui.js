// DOM helpers: subtitles, toast, bond meter, log, settings panel, microphone.

const $ = (sel, root = document) => root.querySelector(sel);

export class Subtitles {
  constructor() {
    this.el = $('#subtitles');
    this.ja = $('.ja', this.el);
    this.en = $('.en', this.el);
    this.hideTimer = 0;
    this.raf = 0;
  }

  setMode(mode) {
    this.el.classList.toggle('mode-en', mode === 'en');
    this.el.classList.toggle('mode-ja', mode === 'ja');
  }

  /** Show a line; the text is revealed in step with the speech duration. */
  show(ja, en, duration) {
    clearTimeout(this.hideTimer);
    cancelAnimationFrame(this.raf);
    this.el.classList.add('show');
    const jaChars = [...ja];
    const enWords = en.split(/(\s+)/);
    const reveal = Math.max(0.6, duration * 0.85);
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 1000 / reveal);
      const nj = Math.ceil(jaChars.length * k);
      const ne = Math.ceil(enWords.length * Math.min(1, k * 1.15));
      this.ja.innerHTML = '';
      this.ja.append(jaChars.slice(0, nj).join(''));
      if (nj < jaChars.length) {
        const dim = document.createElement('span'); dim.className = 'dim'; dim.textContent = jaChars.slice(nj).join('');
        this.ja.append(dim);
      }
      this.en.innerHTML = '';
      this.en.append(enWords.slice(0, ne).join(''));
      if (ne < enWords.length) {
        const dim = document.createElement('span'); dim.className = 'dim'; dim.textContent = enWords.slice(ne).join('');
        this.en.append(dim);
      }
      if (k < 1) this.raf = requestAnimationFrame(step);
    };
    step();
  }

  hideAfter(ms = 3500) {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.el.classList.remove('show'), ms);
  }
}

export function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

export function setThinking(on) {
  $('#thinking').classList.toggle('show', on);
  document.body.classList.toggle('busy', on);
}

export function setBond(value, delta = 0) {
  const el = $('.bond');
  $('.bond-fill', el).style.width = `${Math.max(0, Math.min(100, value))}%`;
  $('.bond-num', el).textContent = Math.round(value);
  if (delta) {
    el.classList.remove('pulse-up', 'pulse-down');
    void el.offsetWidth;
    el.classList.add(delta > 0 ? 'pulse-up' : 'pulse-down');
    setTimeout(() => el.classList.remove('pulse-up', 'pulse-down'), 1400);
  }
}

export function renderLog(log) {
  const list = $('.log-list');
  list.innerHTML = '';
  for (const item of log) {
    const li = document.createElement('li');
    if (item.who === 'you') {
      li.className = 'u';
      li.innerHTML = '<span class="who">You</span>';
      li.append(item.text);
    } else {
      li.className = 'k';
      li.innerHTML = '<span class="who">九喇嘛 Kurama</span><span class="ja" lang="ja"></span><span class="en"></span>';
      $('.ja', li).textContent = item.ja;
      $('.en', li).textContent = item.en;
    }
    list.append(li);
  }
  list.scrollTop = list.scrollHeight;
}

export function setChips(status, voiceOk) {
  const c = $('#chip-claude');
  const mode = status?.claude?.mode;
  c.textContent = mode === 'live' ? 'Claude · live' : mode === 'demo' ? 'Demo mode' : 'Offline';
  c.className = `chip ${mode === 'live' ? 'ok' : 'warn'}`;
  c.title = mode === 'live' ? `Conversation by ${status.claude.model}` : 'No API key: canned replies. See README to connect Claude.';
  const v = $('#chip-voice');
  v.textContent = voiceOk ? 'VOICEVOX' : ('speechSynthesis' in window ? 'Browser voice' : 'No voice');
  v.className = `chip ${voiceOk ? 'ok' : 'warn'}`;
  v.title = voiceOk ? `VOICEVOX:${status?.voicevox?.speaker || '青山龍星'}` : 'VOICEVOX engine not found on :50021 — using the browser voice';
}

/** Bind the settings panel to a live settings/profile object. */
export function bindSettings(conv, onChange) {
  const panel = $('#settings');
  const name = $('#set-name');
  name.value = conv.profile.name;
  name.addEventListener('change', () => { conv.profile.name = name.value.trim(); conv.save(); onChange('name'); });

  const radios = (group, get, set) => {
    for (const r of panel.querySelectorAll(`input[name="${group}"]`)) {
      r.checked = r.value === get();
      r.addEventListener('change', () => { if (r.checked) { set(r.value); conv.save(); onChange(group); } });
    }
  };
  radios('era', () => conv.profile.era, (v) => { conv.profile.era = v; });
  radios('subs', () => conv.settings.subs, (v) => { conv.settings.subs = v; });
  radios('voice', () => conv.settings.voice, (v) => { conv.settings.voice = v; });
  radios('mic', () => conv.settings.mic, (v) => { conv.settings.mic = v; });

  const range = (id, key, fmt) => {
    const el = $(id);
    const out = el.parentElement.querySelector('output');
    el.value = conv.settings[key];
    out.textContent = fmt(conv.settings[key]);
    el.addEventListener('input', () => {
      conv.settings[key] = Number(el.value);
      out.textContent = fmt(conv.settings[key]);
      conv.save();
      onChange(key);
    });
  };
  range('#set-depth', 'depth', (v) => `${Math.round((1 - v) * 100 / 0.22)}%`);
  range('#set-demon', 'demon', (v) => `${Math.round(v * 100)}%`);
  range('#set-volume', 'volume', (v) => `${Math.round(v * 100)}%`);
  range('#set-ambience', 'ambience', (v) => `${Math.round(v * 100)}%`);

  $('#btn-reset').addEventListener('click', () => {
    if (confirm('Make Kurama forget this conversation and reset the bond?')) onChange('reset');
  });

  const toggle = (id) => {
    const p = $(`#${id}`);
    const open = p.hidden;
    for (const other of document.querySelectorAll('.panel')) other.hidden = true;
    p.hidden = !open;
  };
  $('#btn-settings').addEventListener('click', () => toggle('settings'));
  $('#btn-log').addEventListener('click', () => toggle('log'));
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => { $(`#${b.dataset.close}`).hidden = true; });
}

/** Push-to-talk / toggle microphone using the Web Speech API (Chrome, Edge, Safari). */
export class Mic {
  constructor(button, getLang, onText, onInterim) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.button = button;
    if (!SR) { button.hidden = true; return; }
    this.SR = SR;
    this.getLang = getLang;
    this.onText = onText;
    this.onInterim = onInterim;
    this.active = false;
    button.addEventListener('click', () => (this.active ? this.stop() : this.start()));
  }

  start() {
    if (!this.SR || this.active) return;
    const rec = new this.SR();
    rec.lang = this.getLang();
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      this.onInterim(finalText + interim);
    };
    rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') toast(`Microphone: ${e.error}`); };
    rec.onend = () => {
      this.active = false;
      this.button.classList.remove('live');
      if (finalText.trim()) this.onText(finalText.trim());
    };
    this.rec = rec;
    this.active = true;
    this.button.classList.add('live');
    rec.start();
  }

  stop() { this.rec?.stop(); }
}
