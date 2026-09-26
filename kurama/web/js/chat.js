// Conversation state, persistence and the /api calls.

const KEY = 'kurama.v1';

const DEFAULTS = {
  profile: { name: '', era: 'caged', bond: 0 },
  settings: {
    subs: 'both', voice: 'auto', depth: 0.88, demon: 0.55, volume: 0.9, ambience: 0.55, mic: 'en-US',
  },
  history: [],     // [{ role: 'user'|'assistant', content }] — assistant content is the raw JSON reply
  log: [],         // [{ who: 'you'|'kurama', text?, ja?, en? }]
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const data = JSON.parse(raw);
    return {
      profile: { ...DEFAULTS.profile, ...data.profile },
      settings: { ...DEFAULTS.settings, ...data.settings },
      history: Array.isArray(data.history) ? data.history : [],
      log: Array.isArray(data.log) ? data.log : [],
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export class Conversation {
  constructor() {
    const s = load();
    this.profile = s.profile;
    this.settings = s.settings;
    this.history = s.history;
    this.log = s.log;
    this.pending = null;
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        profile: this.profile, settings: this.settings,
        history: this.history.slice(-80), log: this.log.slice(-120),
      }));
    } catch { /* private mode / storage full: keep going in memory */ }
  }

  reset() {
    this.history = [];
    this.log = [];
    this.profile.bond = this.profile.era === 'partner' ? 50 : 0;
    this.save();
  }

  get isNew() { return this.history.length === 0; }

  /**
   * Send a user line (or a stage direction) and get Kurama's reply.
   * @param {string} text
   * @param {{stage?: boolean}} opts  stage directions are not shown in the log
   */
  async send(text, { stage = false } = {}) {
    const messages = [...this.history, { role: 'user', content: text }];
    const body = {
      messages,
      profile: {
        name: this.profile.name || 'unknown',
        era: this.profile.era,
        bond: Math.round(this.profile.bond),
        lang: this.settings.subs === 'ja' ? 'ja' : 'en',
      },
    };
    const ctrl = new AbortController();
    this.pending = ctrl;
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    let reply;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      reply = await res.json();
    } finally {
      clearTimeout(timer);
      this.pending = null;
    }
    if (!reply || typeof reply.ja !== 'string') throw new Error('empty reply');
    this.history.push({ role: 'user', content: text });
    this.history.push({ role: 'assistant', content: reply.raw || JSON.stringify(reply) });
    if (!stage) this.log.push({ who: 'you', text });
    this.log.push({ who: 'kurama', ja: reply.ja, en: reply.en });
    const before = this.profile.bond;
    this.profile.bond = Math.max(0, Math.min(100, before + (Number(reply.bond_delta) || 0) * 2));
    this.save();
    return { ...reply, bondBefore: before, bondAfter: this.profile.bond };
  }

  abort() { this.pending?.abort(); }
}

export async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    return await res.json();
  } catch {
    return { claude: { mode: 'offline' }, voicevox: { ok: false } };
  }
}
