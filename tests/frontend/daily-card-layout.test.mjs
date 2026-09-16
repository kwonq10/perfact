// =========================================================
// public/index.html の日別カードのレイアウトテスト
//
//   実際に起きた不具合の再発検知:
//     「予定を追加」と「この日をコピー」が縦に密着して 1 つの青い塊に見える。
//
//   原因は .daily-result-card > .btn の margin-top:auto が .btn の
//   margin-top:8px を上書きし、余白が尽きると 0 になること。
//   .day-slot-row:last-of-type に margin-bottom を残すことで防いでいる。
//
//   余白の計算は本物のレイアウトエンジンでしか再現できないため、
//   ここだけは headless Chrome を使って getBoundingClientRect() を実測する。
//     - CSS  : public/index.html の <style> をそのまま流し込む
//     - DOM  : page-harness 経由で本物の renderDailyCard() を呼んで生成する
//   どちらもテスト側で書き写さないので、実装が変われば必ず追随する。
//
//   Chrome が見つからない環境ではスキップする（テストを落とさない）。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPage } from './page-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(HERE, '..', '..', 'public', 'index.html');

/** 期待する最小の余白。.day-slot-row の margin-bottom と同じ。 */
const MIN_GAP = 14;

// ---------------------------------------------------------
// Chrome の探索
// ---------------------------------------------------------

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* 探索失敗は無視する */ }
  }
  return null;
}

const CHROME = findChrome();
const SKIP = CHROME ? false : 'Chrome が見つからないためスキップする（CHROME_PATH で指定できる）';

// ---------------------------------------------------------
// 計測用ページの組み立て
// ---------------------------------------------------------

/** public/index.html から <style> ブロックをそのまま取り出す。 */
function extractStyle(html) {
  const start = html.indexOf('<style>');
  const end = html.indexOf('</style>');
  if (start === -1 || end === -1) throw new Error('<style> が見つかりません。');
  return html.slice(start, end + '</style>'.length);
}

/** 本物の renderDailyCard() で n 枠ぶんのカード HTML を作る。 */
function renderCards(maxSlots) {
  const page = loadPage({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
  });
  const cards = [];
  for (let n = 0; n <= maxSlots; n += 1) {
    const slots = [];
    for (let i = 0; i < n; i += 1) {
      slots.push({ start: new Date(2036, 8, 16, 9 + i, 0), end: new Date(2036, 8, 16, 10 + i, 30) });
    }
    page.run(`__day = { date: new Date(2036, 8, 16), dateKey: '2036-09-16', slots: [${
      slots.map((s) => `{ start: new Date(${s.start.getFullYear()}, ${s.start.getMonth()}, ${s.start.getDate()}, ${s.start.getHours()}, 0), `
        + `end: new Date(${s.end.getFullYear()}, ${s.end.getMonth()}, ${s.end.getDate()}, ${s.end.getHours()}, 30) }`).join(', ')
    }] };`);
    cards.push(String(page.run('renderDailyCard(__day)')));
  }
  return cards;
}

/** 計測ページの HTML を組み立てる。#resultView 以下は index.html と同じ並び。 */
function buildProbePage(style, cards) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${style}
</head><body>
<div id="resultView" style="display:block">
  <div class="bg-image-layer" id="bgImageLayer" aria-hidden="true"></div>
  <div class="bg-image-overlay" aria-hidden="true"></div>
  <div id="resultHeader">
    <button id="backBtn">戻る</button>
    <span id="resultTitle">検索結果</span>
    <button id="copyAllBtn">全部コピー</button>
  </div>
  <p class="swipe-intro-hint">スワイプで日付を移動できます</p>
  <div id="resultContent"></div>
</div>
<div class="copy-toast" id="toast">この日をコピーしました</div>
<pre id="out"></pre>
<script>
var CARDS = ${JSON.stringify(cards)};
var rc = document.getElementById('resultContent');
var toast = document.getElementById('toast');
function measure() {
  var card = rc.querySelector('.daily-result-card');
  var copyDay = card.querySelector(':scope > .btn');
  var adds = card.querySelectorAll('.btn-calendar');
  var copies = card.querySelectorAll('.btn-copy');
  var last = adds[adds.length - 1];
  var cardRect = card.getBoundingClientRect();
  var dayRect = copyDay.getBoundingClientRect();
  var r = {
    cardHeight: cardRect.height,
    cardRight: cardRect.right,
    docScrollWidth: document.documentElement.scrollWidth,
    horizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 1
  };
  if (last) {
    var addRect = last.getBoundingClientRect();
    var copyRect = copies[copies.length - 1].getBoundingClientRect();
    r.gap = dayRect.top - addRect.bottom;
    r.rowGap = addRect.left - copyRect.right;
    r.sameRow = Math.abs(addRect.top - copyRect.top) < 0.5;
    r.addBottom = addRect.bottom;
    r.copyDayTop = dayRect.top;
  }
  return r;
}
var results = [];
for (var n = 0; n < CARDS.length; n += 1) {
  rc.innerHTML = CARDS[n];
  toast.classList.remove('show');
  var plain = measure();
  toast.classList.add('show');
  var withToast = measure();
  toast.classList.remove('show');
  results.push({ slots: n, plain: plain, withToast: withToast });
}
var payload = {
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  results: results
};
document.body.innerHTML = '<pre id="out"></pre>';
document.getElementById('out').textContent = JSON.stringify(payload);
</script></body></html>`;
}

/** Chrome を 1 回起動して、指定ウィンドウサイズでの計測結果を得る。 */
function runChrome(chrome, fileUrl, profileDir, width, height) {
  const stdout = execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    '--virtual-time-budget=5000',
    '--dump-dom',
    `--user-data-dir=${profileDir}`,
    fileUrl,
  ], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });

  const m = stdout.match(/<pre id="out">([\s\S]*?)<\/pre>/);
  if (!m) throw new Error('計測結果を取り出せませんでした。');
  const json = m[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  return JSON.parse(json);
}

// ---------------------------------------------------------
// 計測（テスト定義より前に 1 度だけ実行する）
// ---------------------------------------------------------

// ウィンドウサイズと実際のビューポートは一致しない（headless でもツールバー分が引かれる）。
// 実測したビューポートを見出しに出し、幅の区分だけをテストで固定する。
const WINDOWS = [
  { name: 'スマホ幅（縦長）', width: 500, height: 844, expect: 'mobile' },
  { name: 'スマホ幅（高さの低い端末）', width: 500, height: 700, expect: 'mobile' },
  { name: 'PC幅', width: 1280, height: 900, expect: 'desktop' },
];

const MAX_SLOTS = 8;
let measured = null;
let setupError = null;

if (!SKIP) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sukima-layout-'));
  try {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const probe = buildProbePage(extractStyle(html), renderCards(MAX_SLOTS));
    const probePath = path.join(tmpDir, 'probe.html');
    fs.writeFileSync(probePath, probe, 'utf8');
    const fileUrl = 'file:///' + probePath.replace(/\\/g, '/');
    const profileDir = path.join(tmpDir, 'profile');

    measured = WINDOWS.map((w) => ({
      ...w,
      data: runChrome(CHROME, fileUrl, profileDir, w.width, w.height),
    }));
  } catch (e) {
    setupError = e;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 後始末の失敗は無視する */ }
  }
}

/** 計測結果から 1 件取り出す。 */
const viewOf = (name) => measured.find((m) => m.name === name);
const rowOf = (name, slots) => viewOf(name).data.results.find((r) => r.slots === slots);
const label = (name) => {
  const v = viewOf(name);
  return `${name} ${v.data.innerWidth}x${v.data.innerHeight}`;
};

// ---------------------------------------------------------
// テスト
// ---------------------------------------------------------

test('計測の前提: Chrome で 3 種類のビューポートを測れている', { skip: SKIP }, () => {
  assert.equal(setupError, null, setupError ? String(setupError.message) : '');
  assert.equal(measured.length, 3);
  for (const m of measured) {
    assert.ok(m.data.innerWidth > 0 && m.data.innerHeight > 0, `${m.name} のビューポートが取れていない`);
    if (m.expect === 'mobile') {
      assert.ok(m.data.innerWidth <= 599, `${m.name} は 599px 以下であるべき: ${m.data.innerWidth}`);
    } else {
      assert.ok(m.data.innerWidth >= 600, `${m.name} は 600px 以上であるべき: ${m.data.innerWidth}`);
    }
  }
});

test('PC幅: 空き枠がいくつでも「予定を追加」と「この日をコピー」が 14px 以上離れる', { skip: SKIP }, () => {
  // PC幅では min-height が効かないため、余白が尽きて密着した不具合の再現条件そのもの。
  for (let n = 1; n <= MAX_SLOTS; n += 1) {
    const r = rowOf('PC幅', n).plain;
    assert.ok(r.gap >= MIN_GAP, `${label('PC幅')} / 空き枠 ${n} 件: gap=${r.gap}`);
  }
});

test('スマホ幅: 空き枠 4 件以上でも 14px 以上離れる', { skip: SKIP }, () => {
  // カード内容が min-height: calc(100dvh - 180px) を超えると
  // margin-top:auto が 0 になる。そこが密着していた条件。
  for (const name of ['スマホ幅（縦長）', 'スマホ幅（高さの低い端末）']) {
    for (let n = 4; n <= MAX_SLOTS; n += 1) {
      const r = rowOf(name, n).plain;
      assert.ok(r.gap >= MIN_GAP, `${label(name)} / 空き枠 ${n} 件: gap=${r.gap}`);
    }
  }
});

test('密着（gap=0）が 1 パターンも無い', { skip: SKIP }, () => {
  const stuck = [];
  for (const m of measured) {
    for (const r of m.data.results) {
      if (r.plain.gap !== undefined && r.plain.gap < MIN_GAP) {
        stuck.push(`${m.name}/${r.slots}件 gap=${r.plain.gap}`);
      }
    }
  }
  assert.deepEqual(stuck, []);
});

test('スマホ幅: 空き枠 1〜3 件の表示が崩れない', { skip: SKIP }, () => {
  for (const name of ['スマホ幅（縦長）', 'スマホ幅（高さの低い端末）']) {
    for (let n = 1; n <= 3; n += 1) {
      const r = rowOf(name, n).plain;
      assert.ok(r.gap >= MIN_GAP, `${label(name)} / 空き枠 ${n} 件: gap=${r.gap}`);
      assert.ok(r.sameRow, `${label(name)} / 空き枠 ${n} 件: 枠内の 2 ボタンが同じ行に無い`);
      assert.ok(r.rowGap > 0, `${label(name)} / 空き枠 ${n} 件: 枠内の 2 ボタンが重なっている`);
      assert.ok(!r.horizontalScroll, `${label(name)} / 空き枠 ${n} 件: 横スクロールが出ている`);
    }
  }
});

test('スマホ幅: 空き枠が少ないときはカードの下端までボタンを下げる', { skip: SKIP }, () => {
  // margin-top:auto による「カード下端へ固定」が生きていることの確認。
  // 余白が余る 1 件のときは、密着時の 14px より明らかに大きく離れる。
  const r = rowOf('スマホ幅（縦長）', 1).plain;
  assert.ok(r.gap > 100, `余白が余るときに下端へ寄っていない: gap=${r.gap}`);
});

test('どのビューポートでも横スクロールが出ない', { skip: SKIP }, () => {
  for (const m of measured) {
    for (const r of m.data.results) {
      assert.ok(!r.plain.horizontalScroll,
        `${m.name}(${m.data.innerWidth}px) / 空き枠 ${r.slots} 件: scrollWidth=${r.plain.docScrollWidth}`);
      assert.ok(r.plain.cardRight <= m.data.innerWidth + 1,
        `${m.name} / 空き枠 ${r.slots} 件: カードが右へはみ出している`);
    }
  }
});

test('枠内の「この枠をコピー」と「予定を追加」は常に同じ行に並ぶ', { skip: SKIP }, () => {
  for (const m of measured) {
    for (const r of m.data.results) {
      if (r.plain.sameRow === undefined) continue;
      assert.ok(r.plain.sameRow, `${m.name} / 空き枠 ${r.slots} 件: 2 ボタンが折り返している`);
      assert.ok(r.plain.rowGap > 0, `${m.name} / 空き枠 ${r.slots} 件: 2 ボタンが重なっている`);
    }
  }
});

test('コピー完了トースト表示中でもレイアウトが変化しない', { skip: SKIP }, () => {
  for (const m of measured) {
    for (const r of m.data.results) {
      assert.equal(r.withToast.cardHeight, r.plain.cardHeight,
        `${m.name} / 空き枠 ${r.slots} 件: トーストでカード高さが変わった`);
      assert.equal(r.withToast.gap, r.plain.gap,
        `${m.name} / 空き枠 ${r.slots} 件: トーストでボタン間隔が変わった`);
      assert.equal(r.withToast.horizontalScroll, r.plain.horizontalScroll,
        `${m.name} / 空き枠 ${r.slots} 件: トーストで横スクロールの有無が変わった`);
    }
  }
});

// ---------------------------------------------------------
// CSS 自体の回帰ガード（Chrome が無くても動く）
// ---------------------------------------------------------

test('.day-slot-row:last-of-type の margin-bottom を 0 に戻していない', () => {
  const css = fs.readFileSync(INDEX_HTML, 'utf8');
  const m = css.match(/\.day-slot-row:last-of-type\s*\{([^}]*)\}/);
  assert.ok(m, '.day-slot-row:last-of-type の定義が見つからない');

  const mb = m[1].match(/margin-bottom:\s*([^;]+);/);
  assert.ok(mb, 'margin-bottom の指定が消えている');
  const px = Number(String(mb[1]).trim().replace('px', ''));
  assert.ok(px >= MIN_GAP,
    `最終行の margin-bottom が ${MIN_GAP}px 未満だと「この日をコピー」と密着する: ${mb[1]}`);
});

test('.daily-result-card > .btn の margin-top:auto は残っている（下端固定の意図）', () => {
  const css = fs.readFileSync(INDEX_HTML, 'utf8');
  assert.ok(/\.daily-result-card\s*>\s*\.btn\s*\{[^}]*margin-top:\s*auto/.test(css),
    'カード下端へボタンを寄せる指定が消えている');
});
