// =========================================================
// public/index.html の空き時間検索ロジックテスト
//
//   実際の inline script を vm へ読み込み、
//   findFreeSlots() / groupSlotsByDay() / buildDailyResults() を直接呼ぶ。
//   fetchAndCalc() 経由の検証だけは fetch をスタブする。
//   ネットワークへは出ず、Google Calendar も本番データも触らない。
//
//   前提: 業務時間は DAY_START=9 / DAY_END=22、刻みは STEP_MIN=30 分。
//   判定を日付に依存させないため、テストは常に未来日を使う
//   （findFreeSlots は「今日」だけ現在時刻から開始するため）。
//
//   注意: このファイルは端末のタイムゾーンが Asia/Tokyo であることを前提に
//   終日予定を検証する。JST 以外での終日予定の扱いは既知の課題であり、
//   ここでは前提を固定して現行仕様を記録するに留める。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { jsonResponse, loadPage, makeFetch } from './page-harness.mjs';

const OK_FETCH = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

/** 未来年。今日と重ならないので現在時刻の影響を受けない。 */
const Y = 2036;

const page = loadPage({ fetchImpl: OK_FETCH });

/** findFreeSlots のショートハンド。 */
const find = (startDate, endDate, duration, events) =>
  page.call('findFreeSlots', startDate, endDate, duration, events);

/** ローカル時刻から ISO 文字列を作る（Google の dateTime 相当）。 */
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).toISOString();

const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const md = (d) => `${d.getMonth() + 1}/${d.getDate()}`;

/** 枠を "6/1 09:00-22:00" の形にして比較しやすくする。 */
const shape = (slots) => Array.from(slots, (s) => `${md(s.start)} ${hm(s.start)}-${hm(s.end)}`);

/** vm 側の配列をホスト側へ写す（別レルムのままでは deepEqual が通らない）。 */
const count = (v) => Array.from(v).length;

const JST_ONLY = new Date(Y, 5, 1).getTimezoneOffset() === -540;

// =========================================================
// 基本: 空き0件 / 1件 / 複数件
// =========================================================

test('予定が無ければ 09:00-22:00 の 1 枠になる', () => {
  assert.deepEqual(shape(find(`${Y}-06-01`, `${Y}-06-01`, 60, [])), ['6/1 09:00-22:00']);
});

test('業務時間を丸ごと塞ぐ予定があれば空き 0 件', () => {
  assert.equal(count(find(`${Y}-06-01`, `${Y}-06-01`, 60, [
    { start: at(Y, 6, 1, 0, 0), end: at(Y, 6, 2, 0, 0) },
  ])), 0);
});

test('1 件の予定で前後 2 枠に割れる', () => {
  assert.deepEqual(shape(find(`${Y}-06-01`, `${Y}-06-01`, 60, [
    { start: at(Y, 6, 1, 13, 0), end: at(Y, 6, 1, 14, 0) },
  ])), ['6/1 09:00-13:00', '6/1 14:00-22:00']);
});

test('予定が増えれば枠も増える（複数件）', () => {
  assert.deepEqual(shape(find(`${Y}-06-01`, `${Y}-06-01`, 60, [
    { start: at(Y, 6, 1, 11, 0), end: at(Y, 6, 1, 12, 0) },
    { start: at(Y, 6, 1, 15, 0), end: at(Y, 6, 1, 16, 0) },
    { start: at(Y, 6, 1, 18, 0), end: at(Y, 6, 1, 19, 0) },
  ])), ['6/1 09:00-11:00', '6/1 12:00-15:00', '6/1 16:00-18:00', '6/1 19:00-22:00']);
});

// =========================================================
// 境界: 必要時間と隙間の長さ
// =========================================================

test('ちょうど 60 分の隙間は duration=60 で採用する', () => {
  assert.deepEqual(shape(find(`${Y}-06-01`, `${Y}-06-01`, 60, [
    { start: at(Y, 6, 1, 9, 0), end: at(Y, 6, 1, 10, 0) },
    { start: at(Y, 6, 1, 11, 0), end: at(Y, 6, 1, 22, 0) },
  ])), ['6/1 10:00-11:00']);
});

test('60 分に 1 分足りない隙間は duration=60 で採用しない', () => {
  assert.equal(count(find(`${Y}-06-01`, `${Y}-06-01`, 60, [
    { start: at(Y, 6, 1, 9, 0), end: at(Y, 6, 1, 10, 0) },
    { start: at(Y, 6, 1, 10, 59), end: at(Y, 6, 1, 22, 0) },
  ])), 0);
});

test('30 分未満の隙間は duration=30 でも採用しない', () => {
  assert.equal(count(find(`${Y}-06-01`, `${Y}-06-01`, 30, [
    { start: at(Y, 6, 1, 9, 0), end: at(Y, 6, 1, 10, 0) },
    { start: at(Y, 6, 1, 10, 20), end: at(Y, 6, 1, 22, 0) },
  ])), 0);
});

test('ちょうど 30 分の隙間は duration=30 で採用する', () => {
  assert.deepEqual(shape(find(`${Y}-06-01`, `${Y}-06-01`, 30, [
    { start: at(Y, 6, 1, 9, 0), end: at(Y, 6, 1, 10, 0) },
    { start: at(Y, 6, 1, 10, 30), end: at(Y, 6, 1, 22, 0) },
  ])), ['6/1 10:00-10:30']);
});

// =========================================================
// 予定の重なり方
// =========================================================

test('隣接する予定はひとつの塊として扱う（間に空きを作らない）', () => {
  assert.deepEqual(shape(find(`${Y}-06-01`, `${Y}-06-01`, 60, [
    { start: at(Y, 6, 1, 9, 0), end: at(Y, 6, 1, 12, 0) },
    { start: at(Y, 6, 1, 12, 0), end: at(Y, 6, 1, 15, 0) },
  ])), ['6/1 15:00-22:00']);
});

test('重なり合う予定は後ろの終了時刻まで塞ぐ', () => {
  assert.deepEqual(shape(find(`${Y}-06-01`, `${Y}-06-01`, 60, [
    { start: at(Y, 6, 1, 9, 0), end: at(Y, 6, 1, 14, 0) },
    { start: at(Y, 6, 1, 10, 0), end: at(Y, 6, 1, 12, 0) },
  ])), ['6/1 14:00-22:00']);
});

test('同時刻に始まる複数予定は長いほうまで塞ぐ', () => {
  assert.deepEqual(shape(find(`${Y}-06-01`, `${Y}-06-01`, 60, [
    { start: at(Y, 6, 1, 9, 0), end: at(Y, 6, 1, 11, 0) },
    { start: at(Y, 6, 1, 9, 0), end: at(Y, 6, 1, 13, 0) },
  ])), ['6/1 13:00-22:00']);
});

test('予定の並び順が逆でも結果は変わらない', () => {
  const asc = shape(find(`${Y}-06-01`, `${Y}-06-01`, 60, [
    { start: at(Y, 6, 1, 11, 0), end: at(Y, 6, 1, 12, 0) },
    { start: at(Y, 6, 1, 15, 0), end: at(Y, 6, 1, 16, 0) },
  ]));
  const desc = shape(find(`${Y}-06-01`, `${Y}-06-01`, 60, [
    { start: at(Y, 6, 1, 15, 0), end: at(Y, 6, 1, 16, 0) },
    { start: at(Y, 6, 1, 11, 0), end: at(Y, 6, 1, 12, 0) },
  ]));
  assert.deepEqual(desc, asc);
});

// =========================================================
// 日跨ぎ / 深夜 / 23:59 付近 / 終日
// =========================================================

test('日を跨ぐ予定は両日に反映される', () => {
  assert.deepEqual(shape(find(`${Y}-06-01`, `${Y}-06-02`, 60, [
    { start: at(Y, 6, 1, 20, 0), end: at(Y, 6, 2, 11, 0) },
  ])), ['6/1 09:00-20:00', '6/2 11:00-22:00']);
});

test('深夜を跨ぐ予定は 09:00-22:00 の空きに影響しない', () => {
  assert.deepEqual(shape(find(`${Y}-06-01`, `${Y}-06-02`, 60, [
    { start: at(Y, 6, 1, 23, 0), end: at(Y, 6, 2, 1, 0) },
  ])), ['6/1 09:00-22:00', '6/2 09:00-22:00']);
});

test('23:59 に終わる予定も業務時間外なので影響しない', () => {
  assert.deepEqual(shape(find(`${Y}-06-01`, `${Y}-06-01`, 60, [
    { start: at(Y, 6, 1, 22, 0), end: at(Y, 6, 1, 23, 59) },
  ])), ['6/1 09:00-22:00']);
});

test('22:00 をまたぐ予定は 22:00 までを削る', () => {
  assert.deepEqual(shape(find(`${Y}-06-01`, `${Y}-06-01`, 60, [
    { start: at(Y, 6, 1, 21, 0), end: at(Y, 6, 1, 23, 30) },
  ])), ['6/1 09:00-21:00']);
});

test('09:00 前に終わる予定は空きを削らない', () => {
  assert.deepEqual(shape(find(`${Y}-06-01`, `${Y}-06-01`, 60, [
    { start: at(Y, 6, 1, 6, 0), end: at(Y, 6, 1, 8, 30) },
  ])), ['6/1 09:00-22:00']);
});

test('終日予定（date 形式）は当日を塞ぎ、翌日は空ける', { skip: !JST_ONLY && 'JST 環境でのみ検証する' }, () => {
  // Google は終日予定を start.date='YYYY-MM-DD' / end.date=翌日 で返す。
  assert.deepEqual(shape(find(`${Y}-06-01`, `${Y}-06-02`, 60, [
    { start: `${Y}-06-01`, end: `${Y}-06-02` },
  ])), ['6/2 09:00-22:00']);
});

// =========================================================
// 期間の境界
// =========================================================

test('開始日=終了日 なら 1 日分だけ返す', () => {
  assert.deepEqual(shape(find(`${Y}-06-01`, `${Y}-06-01`, 60, [])), ['6/1 09:00-22:00']);
});

test('開始日>終了日 は例外を投げず 0 件', () => {
  let slots;
  assert.doesNotThrow(() => { slots = find(`${Y}-06-05`, `${Y}-06-01`, 60, []); });
  assert.equal(count(slots), 0);
});

test('週を跨ぐ範囲は日数どおりに返す', () => {
  assert.equal(count(find(`${Y}-06-01`, `${Y}-06-08`, 60, [])), 8);
});

test('月を跨ぐ範囲は日数どおりに返す', () => {
  assert.deepEqual(shape(find(`${Y}-06-29`, `${Y}-07-02`, 60, [])),
    ['6/29 09:00-22:00', '6/30 09:00-22:00', '7/1 09:00-22:00', '7/2 09:00-22:00']);
});

test('年を跨ぐ範囲は日数どおりに返す', () => {
  const slots = find(`${Y}-12-30`, `${Y + 1}-01-02`, 60, []);
  assert.equal(count(slots), 4);
  assert.equal(slots[0].start.getFullYear(), Y);
  assert.equal(slots[3].start.getFullYear(), Y + 1);
});

test('うるう年は 2/29 を含む', () => {
  assert.deepEqual(shape(find(`${Y}-02-28`, `${Y}-03-01`, 60, [])),
    ['2/28 09:00-22:00', '2/29 09:00-22:00', '3/1 09:00-22:00']);
});

test('平年は 2/29 を作らない', () => {
  assert.deepEqual(shape(find('2035-02-28', '2035-03-01', 60, [])),
    ['2/28 09:00-22:00', '3/1 09:00-22:00']);
});

test('長期間（1 年）でも完走し 1 日 1 枠になる', () => {
  assert.equal(count(find(`${Y}-01-01`, `${Y}-12-31`, 60, [])), 366); // 2036 はうるう年
});

// =========================================================
// 不正データのガード
// =========================================================

test('日付として解釈できない文字列でも例外を投げず 0 件', () => {
  let slots;
  assert.doesNotThrow(() => { slots = find('abc', 'def', 60, []); });
  assert.equal(count(slots), 0);
});

test('空文字の日付でも例外を投げず 0 件', () => {
  let slots;
  assert.doesNotThrow(() => { slots = find('', '', 60, []); });
  assert.equal(count(slots), 0);
});

test('start / end が欠けた予定が混ざっても落ちない', () => {
  let slots;
  assert.doesNotThrow(() => {
    slots = find(`${Y}-06-01`, `${Y}-06-01`, 60, [
      { start: undefined, end: undefined },
      { start: null, end: null },
      { start: 'not-a-date', end: 'not-a-date' },
    ]);
  });
  assert.deepEqual(shape(slots), ['6/1 09:00-22:00'], '壊れた予定は空きを削らない');
});

test('events が空配列でも落ちない', () => {
  assert.doesNotThrow(() => find(`${Y}-06-01`, `${Y}-06-01`, 60, []));
});

// =========================================================
// groupSlotsByDay / buildDailyResults
// =========================================================

test('groupSlotsByDay は日ごとにまとめる', () => {
  const groups = page.call('groupSlotsByDay', find(`${Y}-06-01`, `${Y}-06-03`, 60, []));
  assert.equal(count(groups), 3);
  assert.deepEqual(Array.from(groups, (g) => g.dateKey), [`${Y}-06-01`, `${Y}-06-02`, `${Y}-06-03`]);
});

test('groupSlotsByDay は壊れた枠を捨てる', () => {
  const groups = page.call('groupSlotsByDay', [
    null,
    { start: 'not-a-date', end: 'not-a-date' },
    { start: new Date(Y, 5, 1, 9, 0), end: new Date(Y, 5, 1, 10, 0) },
  ]);
  assert.equal(count(groups), 1);
  assert.equal(count(groups[0].slots), 1);
});

test('buildDailyResults は空き 0 件の日もカードを作る', () => {
  const slots = find(`${Y}-06-01`, `${Y}-06-03`, 60, [
    { start: at(Y, 6, 2, 0, 0), end: at(Y, 6, 3, 0, 0) },
  ]);
  const days = page.call('buildDailyResults', slots, `${Y}-06-01`, `${Y}-06-03`);
  assert.deepEqual(Array.from(days, (d) => `${d.dateKey}:${count(d.slots)}`),
    [`${Y}-06-01:1`, `${Y}-06-02:0`, `${Y}-06-03:1`]);
});

test('buildDailyResults は過去日だけの範囲なら 0 件', () => {
  assert.equal(count(page.call('buildDailyResults', [], '2020-01-01', '2020-01-03')), 0);
});

test('buildDailyResults は開始日>終了日 なら 0 件', () => {
  assert.equal(count(page.call('buildDailyResults', [], `${Y}-06-05`, `${Y}-06-01`)), 0);
});

// =========================================================
// fetchAndCalc から findFreeSlots へ渡るイベント
//
//   success / authExpired の判定そのものは quota-integration.test.mjs 側で
//   検証済み。ここでは「計算に入る前にどう整形されるか」を見る。
// =========================================================

const SEARCH_START = `${Y}-10-06`;
const SEARCH_END = `${Y}-10-06`;

function searchPage(eventsRespond) {
  const fetchImpl = makeFetch([
    [(u) => u.includes('/users/me/calendarList'), () => jsonResponse(200, { items: [{ id: 'primary' }] })],
    [(u) => u.includes('/events?'), eventsRespond],
  ]);
  const p = loadPage({ fetchImpl });
  p.run("sukimaAuthenticated = true; accessToken = 'test-token'; tokenClient = { requestAccessToken() {} };");
  p.run("calMode = 'select'; calendarList = [{ id: 'primary' }];");
  p.el('startDate').value = SEARCH_START;
  p.el('endDate').value = SEARCH_END;
  p.el('duration').value = '60';
  return { page: p, fetchImpl };
}

const busy = (h1, h2) => ({
  start: { dateTime: at(Y, 10, 6, h1, 0) },
  end: { dateTime: at(Y, 10, 6, h2, 0) },
});

test('fetchAndCalc: 予定ありの結果が currentSlots に入る', async () => {
  const { page: p } = searchPage(() => jsonResponse(200, { items: [busy(13, 14)] }));
  const r = await p.call('fetchAndCalc');
  assert.equal(r.success, true);
  assert.deepEqual(shape(p.run('currentSlots')), ['10/6 09:00-13:00', '10/6 14:00-22:00']);
});

test('fetchAndCalc: transparent（予定ありにしない）予定は空きを削らない', async () => {
  const { page: p } = searchPage(() => jsonResponse(200, {
    items: [{ ...busy(13, 14), transparency: 'transparent' }],
  }));
  await p.call('fetchAndCalc');
  assert.deepEqual(shape(p.run('currentSlots')), ['10/6 09:00-22:00']);
});

test('fetchAndCalc: cancelled の予定は空きを削らない', async () => {
  const { page: p } = searchPage(() => jsonResponse(200, {
    items: [{ ...busy(13, 14), status: 'cancelled' }],
  }));
  await p.call('fetchAndCalc');
  assert.deepEqual(shape(p.run('currentSlots')), ['10/6 09:00-22:00']);
});

// 403 は「そのカレンダーの予定を見る権限が無い」= 元々読めないので無視してよい。
// 429 / 5xx / 通信エラーによる取りこぼしの扱いは calendar-partial-failure.test.mjs を見る。
test('fetchAndCalc: 権限不足(403)のカレンダーがあっても成功分の予定で計算する', async () => {
  let n = 0;
  const fetchImpl = makeFetch([
    [(u) => u.includes('/users/me/calendarList'),
      () => jsonResponse(200, { items: [{ id: 'cal-a' }, { id: 'cal-b' }] })],
    [(u) => u.includes('/events?'), () => {
      n += 1;
      return n === 1 ? jsonResponse(403, { error: 'forbidden' })
        : jsonResponse(200, { items: [busy(13, 14)] });
    }],
  ]);
  const p = loadPage({ fetchImpl });
  p.run("sukimaAuthenticated = true; accessToken = 'test-token'; tokenClient = { requestAccessToken() {} };");
  p.run("calMode = 'all';");
  p.el('startDate').value = SEARCH_START;
  p.el('endDate').value = SEARCH_END;
  p.el('duration').value = '60';

  const r = await p.call('fetchAndCalc');
  assert.equal(r.success, true, '403 は無視して 2xx の分で成功にする');
  assert.deepEqual(shape(p.run('currentSlots')), ['10/6 09:00-13:00', '10/6 14:00-22:00']);
});

test('fetchAndCalc: events が全滅なら結果を作らない（終日空きにしない）', async () => {
  const { page: p } = searchPage(() => jsonResponse(500, { error: 'boom' }));
  p.run('currentSlots = []; currentDailyResults = [];');
  const r = await p.call('fetchAndCalc');

  assert.equal(r.success, false, 'calendarOk=false なら失敗にする');
  assert.equal(count(p.run('currentSlots')), 0, '空き時間を計算していない');
  assert.equal(count(p.run('currentDailyResults')), 0, 'カードを作っていない');
});

test('fetchAndCalc: events が通信エラーでも結果を作らない', async () => {
  const { page: p } = searchPage(() => { throw new Error('network down'); });
  p.run('currentSlots = []; currentDailyResults = [];');
  const r = await p.call('fetchAndCalc');

  assert.equal(r.success, false);
  assert.equal(count(p.run('currentSlots')), 0);
});

test('fetchAndCalc: 未ログインなら Calendar API を呼ばず計算しない', async () => {
  const { page: p, fetchImpl } = searchPage(() => jsonResponse(200, { items: [] }));
  p.run('sukimaAuthenticated = false; currentSlots = [];');
  const r = await p.call('fetchAndCalc');

  assert.equal(r.success, false);
  assert.equal(fetchImpl.eventsCalls().length, 0);
  assert.equal(count(p.run('currentSlots')), 0);
});
