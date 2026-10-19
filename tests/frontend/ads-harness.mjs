// =========================================================
// public/assets/ads-measurement.js と success.html の inline script を
// Node の vm で動かすための最小ハーネス
//
//   - 本物のネットワークへは出ない。fetch はスタブで、呼ばれた URL を記録する。
//   - 「Google への通信」は次の 3 つで観測する:
//       1. fetch の宛先
//       2. document に追加された <script> の src
//       3. window.dataLayer（gtag のキュー）への書き込み
//     gtag.js 本体は読み込まれないので、dataLayer に積まれた命令が
//     「Google のタグが読み込まれた後に送られる内容」になる。
//   - タイマーは手動で進める（実時間を待たない）。
// =========================================================

import fs from 'node:fs';
import vm from 'node:vm';

const SCRIPT_URL = new URL('../../public/assets/ads-measurement.js', import.meta.url);
const SUCCESS_URL = new URL('../../public/billing/success.html', import.meta.url);

export const ADS_SCRIPT = fs.readFileSync(SCRIPT_URL, 'utf8');
export const SUCCESS_HTML = fs.readFileSync(SUCCESS_URL, 'utf8');

/** 要素のスタブ。親子関係とイベントだけを持つ。 */
function makeElement(tag, registry) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    attributes: {},
    listeners: {},
    textContent: '',
    hidden: false,
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      registry.onAppend(child);
      return child;
    },
    removeChild(child) {
      el.children = el.children.filter((c) => c !== child);
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) { el.attributes[name] = String(value); if (name === 'id') el.id = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null; },
    addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
    click() { for (const fn of el.listeners.click || []) fn({ type: 'click' }); },
  };
  return el;
}

function walk(node, fn) {
  fn(node);
  for (const c of node.children || []) walk(c, fn);
}

/** Storage のスタブ。`broken` なら全操作で例外を投げる。 */
export function makeStorage({ broken = false, initial = {} } = {}) {
  const map = new Map(Object.entries(initial));
  const guard = () => { if (broken) throw new Error('SecurityError'); };
  return {
    map,
    getItem(k) { guard(); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { guard(); map.set(k, String(v)); },
    removeItem(k) { guard(); map.delete(k); },
    clear() { guard(); map.clear(); },
  };
}

/**
 * 計測スクリプトを動かす環境を作る。
 *
 * @param {object} o
 * @param {string} [o.href]       ページの URL
 * @param {string} o.page         'lp' | 'success' | 'settings'
 * @param {object} [o.localStorage]
 * @param {object} [o.sessionStorage]
 * @param {boolean} [o.gpc]
 * @param {Function} [o.respond]  (url, init) => {status, body} | Error
 * @param {string} [o.cookie]
 * @param {string} [o.referrer]
 * @param {number} [o.now]
 */
export function createEnv(o = {}) {
  const href = o.href ?? 'https://sukimacalendar.com/about/';
  const url = new URL(href);
  const fetchCalls = [];
  const appendedScripts = [];
  const timers = [];
  const cookieWrites = [];
  let cookieJar = o.cookie ?? '';
  let nowMs = o.now ?? Date.parse('2026-10-18T03:00:00.000Z');

  const registry = {
    onAppend(child) {
      walk(child, (n) => { if (n.tagName === 'SCRIPT') appendedScripts.push(n); });
    },
  };

  const head = makeElement('head', registry);
  const body = makeElement('body', registry);
  const staticById = {};
  for (const id of o.staticIds ?? []) {
    const el = makeElement(id.startsWith('ads') && /Grant|Deny/.test(id) ? 'button' : 'p', registry);
    el.id = id;
    staticById[id] = el;
  }

  const document = {
    head,
    body,
    referrer: o.referrer ?? '',
    currentScript: null,
    createElement: (tag) => makeElement(tag, registry),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text), children: [] }),
    getElementById(id) {
      if (staticById[id]) return staticById[id];
      let hit = null;
      for (const root of [head, body]) walk(root, (n) => { if (!hit && n.id === id) hit = n; });
      return hit;
    },
    get cookie() { return cookieJar; },
    set cookie(v) {
      cookieWrites.push(String(v));
      const [pair] = String(v).split(';');
      const name = pair.split('=')[0].trim();
      if (/Max-Age=0/i.test(v)) {
        cookieJar = cookieJar.split(';').map((s) => s.trim()).filter((s) => s && s.split('=')[0] !== name).join('; ');
      }
    },
  };

  const storageListeners = [];
  const win = {
    location: {
      href, protocol: url.protocol, hostname: url.hostname, pathname: url.pathname,
      search: url.search, hash: url.hash,
    },
    navigator: { globalPrivacyControl: o.gpc === true ? true : undefined },
    localStorage: o.localStorage ?? makeStorage(),
    sessionStorage: o.sessionStorage ?? makeStorage(),
    history: {
      state: null,
      calls: [],
      replaceState(state, title, next) { this.calls.push(next); },
    },
    addEventListener(type, fn) { if (type === 'storage') storageListeners.push(fn); },
    fetch(u, init) {
      fetchCalls.push({ url: String(u), init });
      const r = (o.respond ?? defaultRespond)(String(u), init, fetchCalls.length);
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve({
        status: r.status,
        ok: r.status >= 200 && r.status < 300,
        json: () => (r.body === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(r.body)),
      });
    },
    setTimeout(fn, ms) { timers.push({ fn, ms, id: timers.length + 1, cleared: false }); return timers.length; },
    clearTimeout(id) { const t = timers[id - 1]; if (t) t.cleared = true; },
    __SUKIMA_ADS_NO_AUTOSTART__: true,
    document,
    URL,
    URLSearchParams,
    JSON,
    Date,
    Math,
    Promise,
    console: { log() {}, warn() {}, error() {} },
  };
  win.window = win;

  const ctx = vm.createContext(win);
  vm.runInContext(ADS_SCRIPT, ctx, { filename: 'ads-measurement.js' });

  const api = ctx.SukimaAdsMeasurement.create({
    window: win,
    document,
    page: o.page,
    now: () => nowMs,
    setTimeout: (fn, ms) => win.setTimeout(fn, ms),
    clearTimeout: (id) => win.clearTimeout(id),
  });

  return {
    win,
    document,
    api,
    fetchCalls,
    appendedScripts,
    timers,
    cookieWrites,
    get cookie() { return cookieJar; },
    advance(ms) { nowMs += ms; },
    /** 次の未実行タイマーを 1 つ実行する。無ければ false。 */
    runNextTimer() {
      const t = timers.find((x) => !x.cleared && !x.done);
      if (!t) return false;
      t.done = true;
      nowMs += t.ms;
      t.fn();
      return true;
    },
    pendingTimers() { return timers.filter((x) => !x.cleared && !x.done); },
    /** 別タブでの localStorage 変更を再現する。 */
    otherTabSet(key, value) {
      if (value === null) win.localStorage.map.delete(key);
      else win.localStorage.map.set(key, value);
      for (const fn of storageListeners) fn({ key, newValue: value });
    },
    banner() { return document.getElementById('sukima-ads-consent'); },
    /** Google への通信（fetch / script / dataLayer）が 1 件でもあるか。 */
    googleTraffic() {
      return {
        fetches: fetchCalls.filter((c) => /google|doubleclick/i.test(c.url)).length,
        scripts: appendedScripts.filter((s) => /google|doubleclick/i.test(s.src || '')).length,
        dataLayer: Array.isArray(win.dataLayer) ? win.dataLayer.length : 0,
      };
    },
  };
}

function defaultRespond(u) {
  if (u === '/api/ads/tag-config') return { status: 200, body: { enabled: true, tag_id: 'AW-18481971668' } };
  if (u === '/api/billing/conversion') return { status: 200, body: { state: 'pending' } };
  return { status: 404, body: {} };
}

/** Promise の連鎖を流し切る。 */
export async function flush() {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
}

/** dataLayer の命令を配列の配列にする（arguments オブジェクトを配列へ）。 */
export function commands(win) {
  return (win.dataLayer || []).map((a) => Array.from(a).map(toLocal));
}

/** vm 側で作られた値を、こちら側のオブジェクトへ写す（関数はそのまま残す）。 */
function toLocal(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return Array.from(v).map(toLocal);
  if (typeof v.toISOString === 'function') return new Date(v.getTime());
  const out = {};
  for (const k of Object.keys(v)) out[k] = toLocal(v[k]);
  return out;
}

/** success.html の head にある inline script を取り出す。 */
export function successInlineScript() {
  const noComments = SUCCESS_HTML.replace(/<!--[\s\S]*?-->/g, '');
  const m = noComments.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('inline script が見つかりません。');
  return m[1];
}

/** success.html の inline script を動かす。 */
export function runSuccessInline({ href, sessionStorage = makeStorage(), now = Date.parse('2026-10-18T03:00:00.000Z') }) {
  const url = new URL(href);
  const history = { state: null, calls: [], replaceState(s, t, next) { this.calls.push(next); } };
  const location = { href, pathname: url.pathname, search: url.search, hash: url.hash };
  const FixedDate = class extends Date { static now() { return now; } };
  const win = { location, history, sessionStorage, URLSearchParams, JSON, Date: FixedDate };
  win.window = win;
  vm.runInContext(successInlineScript(), vm.createContext(win));
  return { history, sessionStorage };
}
