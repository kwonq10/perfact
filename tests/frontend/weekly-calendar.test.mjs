// =========================================================
// public/index.html の週間カレンダー（横スクロールの俯瞰表示）テスト
//
//   - 検索結果（currentDailyResults）をそのまま日付ごとの列にする。再計算はしない。
//   - 各列に実際の空き時間（10:00〜11:00 など）を出す。空きなしの日も列を出す。
//   - 既存の日別カード・コピー機能はそのまま残る。
//   - 横スクロールはこの領域だけ（overflow-x + scroll-snap）。日送りスワイプは
//     この領域の上では始めない。
//
//   未来日だけを使い、ネットワークへは出ない（fetch はスタブ）。
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

/** 6/2（月）〜6/4（水）の 3 日。6/4 は終日塞がっていて空きなし。 */
const EVENTS = [
  { start: at(2, 9), end: at(2, 10) },
  { start: at(2, 11), end: at(2, 14) },
  { start: at(2, 15), end: at(2, 22) },   // 6/2: 10:00-11:00, 14:00-15:00
  { start: at(3, 9), end: at(3, 13) },
  { start: at(3, 13, 45), end: at(3, 16) },
  { start: at(3, 17), end: at(3, 22) },   // 6/3: 13:00-13:45, 16:00-17:00
  { start: at(4, 0), end: at(5, 0) },     // 6/4: 空きなし
];

/** findFreeSlots → buildDailyResults → currentDailyResults に入れた状態のページ。 */
function pageWithResults({ duration = 30, events = EVENTS, range = [], startDay = 2, endDay = 4 } = {}) {
  const p = loadPage({ fetchImpl: OK_FETCH });
  p.run(`
    currentSlots = findFreeSlots('${Y}-06-0${startDay}', '${Y}-06-0${endDay}', ${duration}, ${JSON.stringify(events)}${range.length ? ', ' + range.join(', ') : ''});
    currentDailyResults = buildDailyResults(currentSlots, '${Y}-06-0${startDay}', '${Y}-06-0${endDay}');
    currentDayIndex = 0;
  `);
  return p;
}

const weeklyHtml = (p) => p.run('renderWeeklyCalendar(currentDailyResults, currentDayIndex)');

/** 列ごとに [dateKey, 時刻...] を取り出す。 */
function columns(html) {
  return String(html).split('data-weekly-day="').slice(1).map((chunk) => {
    const key = chunk.slice(0, chunk.indexOf('"'));
    const times = Array.from(chunk.matchAll(/<li class="weekly-slot">([^<]+)<\/li>/g), (x) => x[1]);
    const empty = chunk.includes('class="weekly-empty"');
    return { key, times, empty };
  });
}

// =========================================================
// コンテナと列
// =========================================================

test('週間カレンダー用のコンテナを生成する', () => {
  const html = weeklyHtml(pageWithResults());
  assert.match(html, /<div class="weekly-calendar" data-weekly-calendar /);
  assert.match(html, /role="region"/);
  assert.match(html, /aria-label="期間内の空き時間一覧（横にスクロールできます）"/);
});

test('複数日の検索結果が日付ごとの列になる（日付順）', () => {
  const cols = columns(weeklyHtml(pageWithResults()));
  assert.deepEqual(cols.map((c) => c.key), [`${Y}-06-02`, `${Y}-06-03`, `${Y}-06-04`]);
});

test('各列に実際の空き時間を表示する', () => {
  const cols = columns(weeklyHtml(pageWithResults()));
  assert.deepEqual(cols[0].times, ['10:00〜11:00', '14:00〜15:00']);
  assert.deepEqual(cols[1].times, ['13:00〜13:45', '16:00〜17:00']);
});

test('空きなしの日も列を出し、空きなしと表示する', () => {
  const html = weeklyHtml(pageWithResults());
  const cols = columns(html);
  assert.equal(cols[2].key, `${Y}-06-04`);
  assert.deepEqual(cols[2].times, []);
  assert.equal(cols[2].empty, true);
  assert.match(html, /<div class="weekly-empty">空き時間なし<\/div>/);
});

test('曜日と日付を見出しに出す（ja）', () => {
  const html = weeklyHtml(pageWithResults());
  assert.match(html, /<span class="weekly-dow">月<\/span><span class="weekly-date">6\/2<\/span>/);
  assert.match(html, /<span class="weekly-dow">火<\/span><span class="weekly-date">6\/3<\/span>/);
});

test('英語表示では英語の曜日・月名と文言になる', () => {
  const p = pageWithResults();
  p.run("currentLang = 'en';");
  const html = weeklyHtml(p);
  assert.match(html, /<span class="weekly-dow">Mon<\/span><span class="weekly-date">Jun 2<\/span>/);
  assert.match(html, /<div class="weekly-empty">No availability<\/div>/);
  assert.match(html, /aria-label="Free time overview \(scroll sideways\)"/);
});

test('日別カードで表示中の日の列に印を付ける', () => {
  const p = pageWithResults();
  p.run('currentDayIndex = 1;');
  const html = weeklyHtml(p);
  assert.match(html, new RegExp(`class="weekly-day is-current" data-weekly-day="${Y}-06-03" aria-current="date"`));
  assert.equal((html.match(/is-current/g) || []).length, 1);
});

test('検索結果が 0 日なら週間カレンダーを出さない', () => {
  const p = loadPage({ fetchImpl: OK_FETCH });
  assert.equal(p.run('renderWeeklyCalendar([], 0)'), '');
});

// =========================================================
// 既存の日別表示・コピー機能との共存
// =========================================================

test('結果画面は週間カレンダーの下に既存の日別カードを残す', () => {
  const html = pageWithResults().run('renderDailyResultHtml()');
  const weeklyAt = html.indexOf('data-weekly-calendar');
  const cardAt = html.indexOf('data-day-card');
  assert.ok(weeklyAt >= 0, '週間カレンダーがある');
  assert.ok(cardAt > weeklyAt, '日別カードが週間カレンダーの後にある');
  assert.match(html, /data-week-swipe-zone/, '翌週への導線も残る');
});

test('既存のコピー機能（枠コピー・1日分コピー・予定を追加）が残る', () => {
  const p = pageWithResults();
  const html = p.run('renderDailyResultHtml()');
  assert.match(html, /onclick="copySlot\(0\)"/);
  assert.match(html, /onclick="openCalendar\(0\)"/);
  assert.match(html, /onclick="copyCurrentDay\(\)"/);
  for (const fn of ['copySlot', 'copyCurrentDay', 'openCalendar']) {
    assert.equal(p.run(`typeof ${fn}`), 'function', `${fn} が無い`);
  }
});

test('週間カレンダー自体にはコピー等の操作ボタンを置かない（日付ボタンだけ）', () => {
  const html = weeklyHtml(pageWithResults());
  assert.doesNotMatch(html, /copySlot|copyCurrentDay|openCalendar/);
  const buttons = html.match(/<button[^>]*>/g) || [];
  assert.equal(buttons.length, 3, '日付ボタンは日数分');
  for (const b of buttons) assert.match(b, /class="weekly-day-head"/);
});

// =========================================================
// 第 1 弾（所要時間）・第 2 弾（時間帯）の結果がそのまま反映される
// =========================================================

test('所要時間 45 分の結果（ちょうど 45 分の空きを含む）をそのまま表示する', () => {
  const cols = columns(weeklyHtml(pageWithResults({ duration: 45 })));
  assert.deepEqual(cols[0].times, ['10:00〜11:00', '14:00〜15:00']);
  assert.deepEqual(cols[1].times, ['13:00〜13:45', '16:00〜17:00']);
});

test('所要時間 60 分なら 45 分の空きは表示しない', () => {
  const cols = columns(weeklyHtml(pageWithResults({ duration: 60 })));
  assert.deepEqual(cols[1].times, ['16:00〜17:00']);
});

test('時間帯指定（13:00〜18:00）後の結果をそのまま表示する', () => {
  const cols = columns(weeklyHtml(pageWithResults({ duration: 45, range: [m(13), m(18)] })));
  assert.deepEqual(cols[0].times, ['14:00〜15:00']);
  assert.deepEqual(cols[1].times, ['13:00〜13:45', '16:00〜17:00']);
  assert.equal(cols[2].empty, true);
});

test('fetchAndCalc: 45 分・13:00〜18:00 の検索結果が結果画面の週間カレンダーに出る', async () => {
  const items = EVENTS.map((e) => ({ start: { dateTime: e.start }, end: { dateTime: e.end } }));
  const fetchImpl = makeFetch([
    [(u) => u.includes('/users/me/calendarList'), () => jsonResponse(200, { items: [{ id: 'primary' }] })],
    [(u) => u.includes('/events?'), () => jsonResponse(200, { items })],
  ]);
  const p = loadPage({ fetchImpl });
  p.run("sukimaAuthenticated = true; accessToken = 'test-token'; tokenClient = { requestAccessToken() {} };");
  p.run("calMode = 'select'; calendarList = [{ id: 'primary' }];");
  p.el('startDate').value = `${Y}-06-02`;
  p.el('endDate').value = `${Y}-06-04`;
  p.el('duration').value = '45';
  p.el('timeFrom').value = '13:00';
  p.el('timeTo').value = '18:00';

  const r = await p.call('fetchAndCalc');
  assert.equal(r.success, true);
  const html = p.el('resultContent').innerHTML;
  const cols = columns(html);
  assert.deepEqual(cols.map((c) => c.key), [`${Y}-06-02`, `${Y}-06-03`, `${Y}-06-04`]);
  assert.deepEqual(cols[0].times, ['14:00〜15:00']);
  assert.deepEqual(cols[1].times, ['13:00〜13:45', '16:00〜17:00']);
  assert.equal(cols[2].empty, true);
  assert.match(html, /data-day-card/, '日別カードも同時に表示される');
});

// =========================================================
// 横スクロール（CSS）とスワイプ操作の分離
// =========================================================

/** <style> から指定セレクタのルール本体を取り出す。 */
function cssRule(selector) {
  const i = HTML.indexOf(`${selector} {`);
  assert.ok(i >= 0, `${selector} の CSS が無い`);
  return HTML.slice(i, HTML.indexOf('}', i));
}

test('週間カレンダーは横スクロール + scroll-snap の CSS を持つ', () => {
  const rule = cssRule('.weekly-calendar');
  assert.match(rule, /overflow-x: auto/);
  assert.match(rule, /overflow-y: hidden/);
  assert.match(rule, /scroll-snap-type: x proximity/, '強すぎない proximity');
  assert.match(rule, /touch-action: pan-x pan-y/);
  assert.match(rule, /width: 100%/, '画面幅を超えない');
});

test('各列はスナップ位置と最小幅を持ち、スマホで約 3 列になる', () => {
  const rule = cssRule('.weekly-day');
  assert.match(rule, /scroll-snap-align: start/);
  assert.match(rule, /flex: 0 0 clamp\(96px, calc\(\(100% - 16px\) \/ 3\), 140px\)/);
});

test('時刻は折り返さない', () => {
  assert.match(cssRule('.weekly-slot'), /white-space: nowrap/);
});

test('結果領域は横にはみ出さない（ページ全体を横スクロールさせない）', () => {
  assert.match(cssRule('#resultContent'), /overflow: hidden/);
});

test('週間カレンダーの上では日送りスワイプを始めない', () => {
  const p = loadPage({ fetchImpl: OK_FETCH });
  const targetMatching = (wanted) => ({
    closest: (sel) => (String(sel).split(',').map((s) => s.trim()).includes(wanted) ? {} : null),
  });
  assert.equal(p.call('isSwipeExcludedTarget', targetMatching('[data-weekly-calendar]')), true);
  assert.equal(p.call('isSwipeExcludedTarget', targetMatching('[data-day-card]')), false, 'カード上では従来どおり');
});
