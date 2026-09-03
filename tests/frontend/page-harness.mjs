// =========================================================
// public/index.html のインラインスクリプトをテストするためのハーネス
//
//   index.html は単一の inline <script> で構成されており、
//   startSearch() / goToNextWeek() / fetchAndCalc() もその中にある。
//   これらを検証するために、
//     1. index.html から inline script を切り出し
//     2. 最小限の DOM / storage / fetch スタブを備えた vm コンテキストで実行
//   する。index.html 自体は一切改変しない（読み取るだけ）。
//
//   スタブは「トップレベルで実行される処理が落ちない」ことと
//   「テスト対象の関数が触る要素の値を観測できる」ことだけを目的とする。
//   本物のレイアウトやイベント伝播は再現しない。
// =========================================================

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(HERE, '..', '..', 'public', 'index.html');

/** index.html から inline script の中身だけを取り出す。 */
export function extractInlineScript(html) {
  const lines = html.split('\n');
  const start = lines.findIndex((l) => l.trim() === '<script>');
  if (start === -1) throw new Error('inline <script> が見つかりません。');
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '</script>') { end = i; break; }
  }
  if (end === -1) throw new Error('inline </script> が見つかりません。');
  return lines.slice(start + 1, end).join('\n');
}

/** 最小限の要素スタブ。 */
function makeElement(id) {
  const el = {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    checked: false,
    files: [],
    src: '',
    dataset: {},
    style: {},
    children: [],
    addEventListener() {},
    removeEventListener() {},
    removeChild() {},
    remove() {},
    setAttribute(k, v) { el.dataset[k] = v; },
    getAttribute(k) { return el.dataset[k] === undefined ? null : el.dataset[k]; },
    removeAttribute() {},
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 100, right: 100, bottom: 100 }; },
    focus() {}, blur() {}, click() {}, scrollIntoView() {},
    setPointerCapture() {}, releasePointerCapture() {},
    closest() { return null; },
  };
  // 子要素の検索は、同じセレクタなら同じスタブを返す（null を返さない）。
  // 本物の DOM ではないため一致判定は行わない。
  const found = new Map();
  el.querySelector = (sel) => {
    const key = String(sel);
    if (!found.has(key)) found.set(key, makeElement(id + ' > ' + key));
    return found.get(key);
  };
  el.appendChild = (child) => { el.children.push(child); return child; };
  el.insertBefore = (child) => { el.children.push(child); return child; };
  const set = new Set();
  el.classList = {
    add(...c) { c.forEach((x) => set.add(x)); },
    remove(...c) { c.forEach((x) => set.delete(x)); },
    contains(c) { return set.has(c); },
    toggle(c, on) {
      const want = on === undefined ? !set.has(c) : !!on;
      if (want) set.add(c); else set.delete(c);
      return want;
    },
  };
  return el;
}

/** Map ベースの Storage スタブ。 */
function makeStorage() {
  const m = new Map();
  return {
    getItem(k) { return m.has(String(k)) ? m.get(String(k)) : null; },
    setItem(k, v) { m.set(String(k), String(v)); },
    removeItem(k) { m.delete(String(k)); },
    clear() { m.clear(); },
    key(i) { const a = Array.from(m.keys()); return i < a.length ? a[i] : null; },
    get length() { return m.size; },
    _map: m,
  };
}

/** JSON レスポンスのスタブ。 */
export function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
    async text() { return JSON.stringify(body); },
  };
}

/** JSON として壊れている応答。 */
export function brokenJsonResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { throw new SyntaxError('Unexpected token'); },
    async text() { return 'not json'; },
  };
}

/**
 * fetch のスタブ。
 *
 * routes は [ [判定関数, 応答を返す関数], … ]。
 * 先に一致したものを使う。どれにも一致しなければ 404 を返す。
 * 呼び出しはすべて calls に記録する。
 */
export function makeFetch(routes = []) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (init.method || 'GET').toUpperCase(), init });
    for (const [match, respond] of routes) {
      if (match(u, init)) return respond(u, init);
    }
    return jsonResponse(404, { error: 'not_stubbed' });
  };
  fn.calls = calls;
  fn.eventsCalls = () => calls.filter((c) => c.url.includes('/events?'));
  fn.quotaCalls = (kind) => calls.filter((c) => c.url.includes('/api/quota/' + kind));
  return fn;
}

/**
 * index.html の inline script を vm で読み込む。
 *
 * 戻り値:
 *   el(id)          要素スタブを取得する
 *   run(code)       コンテキスト内で式を評価する（let 変数の読み書きに使う）
 *   call(fn, ...a)  コンテキスト内の関数を呼ぶ
 *   warnings        console.warn の記録
 */
export function loadPage(options = {}) {
  const { fetchImpl } = options;
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const source = extractInlineScript(html);

  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const warnings = [];
  const errors = [];

  const documentStub = {
    getElementById: (id) => getEl(id),
    querySelector: (sel) => getEl('sel:' + sel),
    querySelectorAll: () => [],
    createElement: (tag) => makeElement('created:' + tag),
    createTextNode: () => makeElement('text'),
    addEventListener() {},
    removeEventListener() {},
    body: makeElement('body'),
    documentElement: makeElement('html'),
    head: makeElement('head'),
    title: '',
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    cookie: '',
  };

  const sandbox = {
    console: {
      log() {}, info() {}, debug() {},
      warn: (...a) => warnings.push(a.map(String).join(' ')),
      error: (...a) => errors.push(a.map(String).join(' ')),
    },
    document: documentStub,
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    navigator: {
      language: 'ja',
      userAgent: 'test',
      clipboard: { writeText: async () => {} },
    },
    location: {
      href: 'https://sukimacalendar.com/',
      origin: 'https://sukimacalendar.com',
      search: '', pathname: '/', hostname: 'sukimacalendar.com',
      reload() {}, assign() {}, replace() {},
    },
    fetch: fetchImpl,
    crypto: globalThis.crypto,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (h) => clearTimeout(h),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({
      matches: false,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {},
    }),
    URL, URLSearchParams, TextEncoder, TextDecoder, Blob,
    btoa: globalThis.btoa, atob: globalThis.atob,
    Image: function Image() { return makeElement('img'); },
    FileReader: function FileReader() { return { readAsDataURL() {}, addEventListener() {} }; },
    alert() {}, confirm() { return false; }, prompt() { return null; },
    scrollTo() {}, scrollBy() {},
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 2,
    addEventListener() {}, removeEventListener() {},
    onload: null,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'public/index.html (inline)' });

  return {
    context,
    el: getEl,
    elements,
    warnings,
    errors,
    run: (code) => vm.runInContext(code, context),
    call: (fnName, ...args) => {
      const fn = context[fnName];
      if (typeof fn !== 'function') throw new Error(fnName + ' が見つかりません。');
      return fn(...args);
    },
  };
}
