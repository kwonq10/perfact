// =========================================================
// public/index.html の週間カレンダー → 日別詳細への切り替えテスト
//
//   - 各列の日付部分は <button>（triggerDateNav）。押すとその日が選択中になり、
//     下の日別カードがその日の内容になる。新しい検索はしない。
//   - 選択中の印（is-current / aria-current="date"）は、日付ボタンでも日送りスワイプでも同期する。
//   - 描き直しても、同じ検索結果のあいだは週間カレンダーの横位置と
//     日付ボタンのフォーカスを保つ。
//
//   アニメーションは prefers-reduced-motion で 0ms にして同期的に検証する
//   （アニメーションありの経路も 1 件だけ実時間で確認する）。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { jsonResponse, loadPage, makeFetch } from './page-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(HERE, '..', '..', 'public', 'index.html'), 'utf8');

const OK_FETCH = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

/** 未来年。2036-06-02 は月曜。 */
const Y = 2036;
const at = (d, h, mi = 0) => new Date(Y, 5, d, h, mi).toISOString();
const m = (h, mi = 0) => h * 60 + mi;
const D1 = `${Y}-06-02`;
const D2 = `${Y}-06-03`;
const D3 = `${Y}-06-04`;

/** 6/2: 10:00-11:00, 14:00-15:00 / 6/3: 13:00-13:45, 16:00-17:00 / 6/4: 空きなし */
const EVENTS = [
  { start: at(2, 9), end: at(2, 10) },
  { start: at(2, 11), end: at(2, 14) },
  { start: at(2, 15), end: at(2, 22) },
  { start: at(3, 9), end: at(3, 13) },
  { start: at(3, 13, 45), end: at(3, 16) },
  { start: at(3, 17), end: at(3, 22) },
  { start: at(4, 0), end: at(5, 0) },
];

/**
 * 結果画面を表示した状態のページ。
 * スタブの DOM は HTML を解釈しないので、週間カレンダー要素だけは
 * 「描き直すたびに新しい要素になる」本物に近いフェイクへ差し替える。
 */
function resultPage({ duration = 30, range = [], reducedMotion = true } = {}) {
  const p = loadPage({ fetchImpl: OK_FETCH });
  if (reducedMotion) p.run('window.matchMedia = () => ({ matches: true });');
  p.run(`
    var __focused = [];
    var __copied = [];
    navigator.clipboard.writeText = async (text) => { __copied.push(text); };
    (() => {
      const rc = document.getElementById('resultContent');
      const orig = document.querySelector;
      let lastHtml = null;
      let weekly = null;
      document.querySelector = (sel) => {
        if (sel === '[data-weekly-calendar]') {
          if (rc.innerHTML !== lastHtml) {
            lastHtml = rc.innerHTML;
            const mm = /data-weekly-range="([^"]+)"/.exec(lastHtml);
            weekly = mm ? { scrollLeft: 0, getAttribute: (k) => (k === 'data-weekly-range' ? mm[1] : null) } : null;
          }
          return weekly;
        }
        const nav = /^\\[data-weekly-nav="([^"]+)"\\]$/.exec(sel);
        if (nav) {
          return rc.innerHTML.includes('data-weekly-nav="' + nav[1] + '"')
            ? { focus: (opts) => __focused.push({ key: nav[1], opts }) }
            : null;
        }
        return orig(sel);
      };
    })();
    currentSlots = findFreeSlots('${D1}', '${D3}', ${duration}, ${JSON.stringify(EVENTS)}${range.length ? ', ' + range.join(', ') : ''});
    currentDailyResults = buildDailyResults(currentSlots, '${D1}', '${D3}');
    currentDayIndex = 0;
    renderCurrentDay();
  `);
  return p;
}

const html = (p) => p.el('resultContent').innerHTML;
const cardPart = (p) => html(p).slice(html(p).indexOf('data-day-card'));
const currentKey = (p) => (/class="weekly-day[^"]*is-current[^"]*" data-weekly-day="([^"]+)"/.exec(html(p)) || [])[1];
const cardTimes = (p) => Array.from(cardPart(p).matchAll(/<div class="slot-time">([^<]+)<span>〜<\/span>([^<]+)<\/div>/g),
  (x) => `${x[1]}〜${x[2]}`);

// =========================================================
// 日付ボタン
// =========================================================

test('各列の日付部分は操作可能な button になっている', () => {
  const p = resultPage();
  const buttons = html(p).match(/<button type="button" class="weekly-day-head"[^>]*>/g) || [];
  assert.equal(buttons.length, 3);
  for (const [i, key] of [D1, D2, D3].entries()) {
    assert.match(buttons[i], new RegExp(`data-weekly-nav="${key}"`));
    assert.match(buttons[i], new RegExp(`onclick="triggerDateNav\\('${key}'\\)"`));
  }
});

test('日付ボタンは日本語のアクセシブルなラベルを持つ', () => {
  const h = html(resultPage());
  assert.match(h, /aria-label="6月2日（月）の詳細を表示"/);
  assert.match(h, /aria-label="6月4日（水）の詳細を表示"/);
});

test('英語表示では英語のアクセシブルなラベルになる', () => {
  const p = resultPage();
  p.run("currentLang = 'en'; renderCurrentDay();");
  assert.match(html(p), /aria-label="Show details for Tue, Jun 3"/);
});

test('日付ボタンは 44px 以上のタップ領域とフォーカス表示を持つ', () => {
  // CSS はページのソースで確認する（スタブはレイアウトしない）。
  const i = HTML.indexOf('.weekly-day-head {');
  assert.ok(i >= 0);
  const rule = HTML.slice(i, HTML.indexOf('}', i));
  assert.match(rule, /min-height: 44px/);
  assert.match(rule, /width: 100%/);
  assert.match(HTML, /\.weekly-day-head:focus-visible \{ outline: 2px solid #4f8ef7/);
});

// =========================================================
// タップでの切り替え
// =========================================================

test('2 日目をタップすると 2 日目の詳細になる', () => {
  const p = resultPage();
  p.call('triggerDateNav', D2);
  assert.equal(p.run('currentDayIndex'), 1);
  assert.match(cardPart(p), /2036年6月3日（火）/);
  assert.deepEqual(cardTimes(p), ['13:00〜13:45', '16:00〜17:00']);
});

test('3 日目（空きなし）をタップすると 3 日目の詳細になり「空き時間なし」を表示する', () => {
  const p = resultPage();
  p.call('triggerDateNav', D3);
  assert.equal(p.run('currentDayIndex'), 2);
  assert.match(cardPart(p), /2036年6月4日（水）/);
  assert.match(cardPart(p), /<div class="no-slots-message">空き時間なし<\/div>/);
  assert.match(cardPart(p), /onclick="copyCurrentDay\(\)" disabled/, '空きなしの日は 1 日分コピーを押せない（既存仕様）');
});

test('aria-current と青枠（is-current）が選択した日に移る', () => {
  const p = resultPage();
  assert.equal(currentKey(p), D1);
  p.call('triggerDateNav', D3);
  assert.equal(currentKey(p), D3);
  assert.match(html(p), new RegExp(`class="weekly-day is-current" data-weekly-day="${D3}" aria-current="date"`));
  assert.equal((html(p).match(/aria-current="date"/g) || []).length, 1);
});

test('表示中の日をタップしても何も変わらない', () => {
  const p = resultPage();
  const before = html(p);
  p.call('triggerDateNav', D1);
  assert.equal(p.run('currentDayIndex'), 0);
  assert.equal(html(p), before);
});

test('検索中・アニメーション中のタップは無視する', () => {
  const p = resultPage();
  p.run('isSearching = true;');
  p.call('triggerDateNav', D2);
  assert.equal(p.run('currentDayIndex'), 0);
  p.run('isSearching = false; isAnimating = true;');
  p.call('triggerDateNav', D2);
  assert.equal(p.run('currentDayIndex'), 0);
});

test('アニメーションありでも、終わればその日の詳細になる', async () => {
  const p = resultPage({ reducedMotion: false });
  p.call('triggerDateNav', D2);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(p.run('currentDayIndex'), 1);
  assert.equal(currentKey(p), D2);
  assert.equal(p.run('isAnimating'), false);
});

// =========================================================
// 日送りスワイプとの同期
// =========================================================

test('日送りスワイプ（次の日）後も週間カレンダーの選択表示が同期する', () => {
  const p = resultPage();
  p.run("animateDayChange('next', getDayCardEl());");
  assert.equal(p.run('currentDayIndex'), 1);
  assert.equal(currentKey(p), D2);
});

test('日付タップ → 日送りスワイプ（前の日）の順でも同期する', () => {
  const p = resultPage();
  p.call('triggerDateNav', D3);
  p.run("animateDayChange('previous', getDayCardEl());");
  assert.equal(p.run('currentDayIndex'), 1);
  assert.equal(currentKey(p), D2);
  assert.deepEqual(cardTimes(p), ['13:00〜13:45', '16:00〜17:00']);
});

// =========================================================
// 横位置・フォーカスの保持
// =========================================================

test('日付を切り替えて描き直しても、横スクロール位置を先頭へ戻さない', () => {
  const p = resultPage();
  p.run("document.querySelector('[data-weekly-calendar]').scrollLeft = 240;");
  p.call('triggerDateNav', D3);
  assert.equal(p.run("document.querySelector('[data-weekly-calendar]').scrollLeft"), 240);
  p.run("animateDayChange('previous', getDayCardEl());");
  assert.equal(p.run("document.querySelector('[data-weekly-calendar]').scrollLeft"), 240, 'スワイプでも保つ');
});

test('別の検索結果に変わったら横スクロール位置は先頭に戻る', () => {
  const p = resultPage();
  p.run("document.querySelector('[data-weekly-calendar]').scrollLeft = 240;");
  p.run(`
    currentDailyResults = buildDailyResults(currentSlots, '${D1}', '${D2}');
    currentDayIndex = 0;
    renderCurrentDay();
  `);
  assert.equal(p.run("document.querySelector('[data-weekly-calendar]').scrollLeft"), 0);
});

test('キーボードで日付ボタンを押した場合、描き直し後も同じ日付ボタンにフォーカスを戻す', () => {
  const p = resultPage();
  p.run(`document.activeElement = { getAttribute: (k) => (k === 'data-weekly-nav' ? '${D2}' : null) };`);
  p.call('triggerDateNav', D2);
  const focused = p.run('__focused');
  assert.equal(focused.length, 1);
  assert.equal(focused[0].key, D2);
  assert.equal(focused[0].opts.preventScroll, true, 'フォーカスでページを動かさない');
});

test('日付ボタン以外にフォーカスがあるときは、フォーカスを動かさない', () => {
  const p = resultPage();
  p.run('document.activeElement = null;');
  p.call('triggerDateNav', D2);
  assert.equal(p.run('__focused.length'), 0);
});

// =========================================================
// 既存機能・第 1 弾・第 2 弾
// =========================================================

test('切り替え後もコピー・1 日分コピー・予定を追加・翌週導線が残り、選択した日を対象にする', async () => {
  const p = resultPage();
  p.call('triggerDateNav', D2);
  const card = cardPart(p);
  assert.match(card, /onclick="copySlot\(0\)"/);
  assert.match(card, /onclick="openCalendar\(0\)"/);
  assert.match(card, /onclick="copyCurrentDay\(\)"/);
  assert.match(html(p), /data-week-swipe-zone/);

  p.call('copySlot', 1);
  p.call('copyCurrentDay');
  await new Promise((r) => setTimeout(r, 0));
  const copied = Array.from(p.run('__copied'));
  assert.equal(copied[0], '6月3日(火) 16:00〜17:00');
  assert.equal(copied[1], '6月3日(火) 13:00〜13:45\n6月3日(火) 16:00〜17:00');
});

test('第 1 弾: 45 分の結果は切り替え後も正しい（60 分なら 45 分枠は出ない）', () => {
  const p45 = resultPage({ duration: 45 });
  p45.call('triggerDateNav', D2);
  assert.deepEqual(cardTimes(p45), ['13:00〜13:45', '16:00〜17:00']);

  const p60 = resultPage({ duration: 60 });
  p60.call('triggerDateNav', D2);
  assert.deepEqual(cardTimes(p60), ['16:00〜17:00']);
});

test('第 2 弾: 時間帯（13:00〜18:00）で絞った結果は切り替え後もそのまま', () => {
  const p = resultPage({ duration: 45, range: [m(13), m(18)] });
  assert.deepEqual(cardTimes(p), ['14:00〜15:00']);
  p.call('triggerDateNav', D2);
  assert.deepEqual(cardTimes(p), ['13:00〜13:45', '16:00〜17:00']);
});

test('fetchAndCalc の結果画面から日付タップで切り替えられる（新しい検索はしない）', async () => {
  const items = EVENTS.map((e) => ({ start: { dateTime: e.start }, end: { dateTime: e.end } }));
  const fetchImpl = makeFetch([
    [(u) => u.includes('/users/me/calendarList'), () => jsonResponse(200, { items: [{ id: 'primary' }] })],
    [(u) => u.includes('/events?'), () => jsonResponse(200, { items })],
  ]);
  const p = loadPage({ fetchImpl });
  p.run('window.matchMedia = () => ({ matches: true });');
  p.run("sukimaAuthenticated = true; accessToken = 'test-token'; tokenClient = { requestAccessToken() {} };");
  p.run("calMode = 'select'; calendarList = [{ id: 'primary' }];");
  p.el('startDate').value = D1;
  p.el('endDate').value = D3;
  p.el('duration').value = '45';
  const r = await p.call('fetchAndCalc');
  assert.equal(r.success, true);
  const eventsCallsBefore = fetchImpl.eventsCalls().length;

  p.call('triggerDateNav', D3);
  assert.equal(p.run('currentDayIndex'), 2);
  assert.match(cardPart(p), /空き時間なし/);
  assert.equal(fetchImpl.eventsCalls().length, eventsCallsBefore, 'Calendar API を呼び直さない');
  assert.equal(fetchImpl.quotaCalls('reserve').length, 0, '検索回数も使わない');
});
