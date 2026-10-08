// =========================================================
// public/index.html の「検索する時間帯」テスト
//
//   1. 選択肢: 06:00〜23:30 を STEP_MIN（30 分）刻み。初期値は従来どおり 09:00〜22:00。
//   2. 文言: ja / en の両方がある。
//   3. 検索: findFreeSlots は指定時間帯の外の空きを返さない。時間帯を渡さなければ
//      従来の 09:00〜22:00 のまま（既存の呼び出しと互換）。
//   4. 入力チェック: 開始 >= 終了、または時間帯が所要時間より短い場合は、
//      quota を予約する前に止め、理由を表示する。
//
//   未来日だけを使い、ネットワークへは出ない（fetch はスタブ）。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { jsonResponse, loadPage, makeFetch } from './page-harness.mjs';

const OK_FETCH = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

/** 未来年。今日と重ならないので現在時刻の影響を受けない。 */
const Y = 2036;

const page = loadPage({ fetchImpl: OK_FETCH });

/** 6/1 のローカル時刻から ISO 文字列を作る。 */
const at = (h, mi = 0) => new Date(Y, 5, 1, h, mi).toISOString();
const m = (h, mi = 0) => h * 60 + mi;

const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const shape = (slots) => Array.from(slots, (s) => `${hm(s.start)}-${hm(s.end)}`);

/** findFreeSlots(6/1 の 1 日, duration, events, from, to)。from/to を省くと既定値。 */
const find = (duration, events, ...range) =>
  page.call('findFreeSlots', `${Y}-06-01`, `${Y}-06-01`, duration, events, ...range);

// =========================================================
// 選択肢・初期値・文言
// =========================================================

function optionValues(html) {
  return Array.from(String(html).matchAll(/<option value="([^"]+)"/g), (o) => o[1]);
}

test('時間帯の選択肢は 06:00〜23:30 の 30 分刻み', () => {
  const values = optionValues(page.call('timeRangeOptionsHtml', m(9)));
  assert.equal(values.length, 36);
  assert.equal(values[0], '06:00');
  assert.equal(values[1], '06:30');
  assert.equal(values[values.length - 1], '23:30');
  assert.ok(values.includes('13:00') && values.includes('18:00') && values.includes('22:00'));
});

test('初期値は従来の固定範囲と同じ 09:00〜22:00', () => {
  const p = loadPage({ fetchImpl: OK_FETCH });
  p.call('renderTimeRangeOptions');
  assert.equal(p.el('timeFrom').value, '09:00');
  assert.equal(p.el('timeTo').value, '22:00');
  assert.match(p.el('timeFrom').innerHTML, /<option value="09:00" selected>/);
  assert.match(p.el('timeTo').innerHTML, /<option value="22:00" selected>/);
});

test('時間帯が未設定なら 09:00〜22:00 として扱う', () => {
  const p = loadPage({ fetchImpl: OK_FETCH });
  const r = p.call('getSearchTimeRange');
  assert.equal(r.fromMin, m(9));
  assert.equal(r.toMin, m(22));
});

test('時間帯の文言は ja / en の両方にある', () => {
  for (const key of ['labelTimeRange', 'timeFromLabel', 'timeToLabel', 'invalidTimeRange', 'timeRangeTooShort']) {
    for (const lang of ['ja', 'en']) {
      const v = page.run(`I18N.${lang}.${key}`);
      assert.equal(typeof v, 'string', `I18N.${lang}.${key} が無い`);
      assert.ok(v.length > 0);
    }
  }
});

// =========================================================
// findFreeSlots: 指定時間帯への反映
// =========================================================

test('時間帯を渡さなければ従来どおり 09:00-22:00', () => {
  assert.deepEqual(shape(find(60, [])), ['09:00-22:00']);
});

test('13:00〜18:00 なら、その範囲だけを返す', () => {
  assert.deepEqual(shape(find(60, [], m(13), m(18))), ['13:00-18:00']);
});

test('18:00〜22:00 なら、18:00 より前の空きは返さない', () => {
  assert.deepEqual(shape(find(60, [{ start: at(19), end: at(20) }], m(18), m(22))),
    ['18:00-19:00', '20:00-22:00']);
});

test('開始時刻ちょうどから空いている枠を返す', () => {
  assert.deepEqual(shape(find(60, [{ start: at(14), end: at(18) }], m(13), m(18))), ['13:00-14:00']);
});

test('終了時刻ちょうどまでの空きを返す', () => {
  assert.deepEqual(shape(find(60, [{ start: at(13), end: at(17) }], m(13), m(18))), ['17:00-18:00']);
});

test('開始時刻をまたぐ予定は、その終わりから空きにする', () => {
  assert.deepEqual(shape(find(60, [{ start: at(12), end: at(14) }], m(13), m(18))), ['14:00-18:00']);
});

test('終了時刻をまたぐ予定は、その始まりまでを空きにする', () => {
  assert.deepEqual(shape(find(60, [{ start: at(17), end: at(19) }], m(13), m(18))), ['13:00-17:00']);
});

test('時間帯の外だけにある予定は空きを削らない', () => {
  assert.deepEqual(shape(find(60, [
    { start: at(9), end: at(12) },
    { start: at(19), end: at(21) },
  ], m(13), m(18))), ['13:00-18:00']);
});

test('開始 >= 終了 なら例外を投げず 0 件', () => {
  assert.deepEqual(shape(find(30, [], m(18), m(13))), []);
  assert.deepEqual(shape(find(30, [], m(13), m(13))), []);
});

test('時間帯が所要時間より短ければ 0 件', () => {
  assert.deepEqual(shape(find(60, [], m(13), m(13, 30))), []);
});

test('30 分刻みでない時刻でも分単位で扱う（13:30〜14:15、45 分）', () => {
  assert.deepEqual(shape(find(45, [], m(13, 30), m(14, 15))), ['13:30-14:15']);
});

test('13:00〜18:00・45 分: 範囲内の 45 分以上の空きだけを返す', () => {
  const events = [
    { start: at(9), end: at(13, 30) },    // 開始時刻をまたぐ → 13:00-13:30 は塞がる
    { start: at(14, 15), end: at(15) },   // 13:30-14:15 = 45 分 → 採用
    { start: at(15, 30), end: at(17) },   // 15:00-15:30 = 30 分 → 不採用
    { start: at(17, 45), end: at(20) },   // 17:00-17:45 = 45 分 → 採用（終了時刻をまたぐ）
  ];
  assert.deepEqual(shape(find(45, events, m(13), m(18))), ['13:30-14:15', '17:00-17:45']);
});

test('13:00〜18:00・45 分: 時間帯の外にある長い空きは返さない', () => {
  assert.deepEqual(shape(find(45, [{ start: at(13), end: at(18) }], m(13), m(18))), []);
});

// =========================================================
// validateSearchTimeRange
// =========================================================

function rangePage(from, to) {
  const p = loadPage({ fetchImpl: OK_FETCH });
  p.el('timeFrom').value = from;
  p.el('timeTo').value = to;
  return p;
}

test('validateSearchTimeRange: 正しい範囲なら null', () => {
  assert.equal(rangePage('13:00', '18:00').call('validateSearchTimeRange', 45), null);
});

test('validateSearchTimeRange: 開始 = 終了 は invalidTimeRange', () => {
  assert.equal(rangePage('13:00', '13:00').call('validateSearchTimeRange', 30), 'invalidTimeRange');
});

test('validateSearchTimeRange: 開始 > 終了 は invalidTimeRange', () => {
  assert.equal(rangePage('18:00', '13:00').call('validateSearchTimeRange', 30), 'invalidTimeRange');
});

test('validateSearchTimeRange: 所要時間より短い時間帯は timeRangeTooShort', () => {
  assert.equal(rangePage('13:00', '13:30').call('validateSearchTimeRange', 45), 'timeRangeTooShort');
});

test('validateSearchTimeRange: 時間帯と所要時間が同じ長さなら通す', () => {
  assert.equal(rangePage('13:00', '14:00').call('validateSearchTimeRange', 60), null);
});

// =========================================================
// startSearch / goToNextWeek / fetchAndCalc との結線
// =========================================================

const RESERVE_OK = {
  quota_enforced: true, allowed: true, code: 'ok', reused: false,
  reservation_id: 'c9f17da8-e426-46b9-ac84-b1b6159fc53c', week_start: `${Y}-06-01`,
  used: 1, remaining: 2, expires_at: `${Y}-06-01T00:02:00.000Z`,
};

function searchPage({ from, to, duration = '45', items = [] }) {
  const fetchImpl = makeFetch([
    [(u) => u.includes('/api/quota/reserve'), () => jsonResponse(200, RESERVE_OK)],
    [(u) => u.includes('/api/quota/commit'), () => jsonResponse(200, { quota_enforced: true, ok: true, code: 'ok' })],
    [(u) => u.includes('/api/quota/release'), () => jsonResponse(200, { quota_enforced: true, ok: true, code: 'ok' })],
    [(u) => u.includes('/users/me/calendarList'), () => jsonResponse(200, { items: [{ id: 'primary' }] })],
    [(u) => u.includes('/events?'), () => jsonResponse(200, { items })],
  ]);
  const p = loadPage({ fetchImpl });
  p.run("sukimaAuthenticated = true; accessToken = 'test-token'; tokenClient = { requestAccessToken() {} };");
  p.run("calMode = 'select'; calendarList = [{ id: 'primary' }];");
  p.el('startDate').value = `${Y}-06-01`;
  p.el('endDate').value = `${Y}-06-01`;
  p.el('duration').value = duration;
  p.el('timeFrom').value = from;
  p.el('timeTo').value = to;
  return { page: p, fetchImpl };
}

test('startSearch: 開始 >= 終了 なら quota を予約せず、エラーを表示する', async () => {
  const { page: p, fetchImpl } = searchPage({ from: '18:00', to: '13:00' });
  await p.call('startSearch');
  assert.equal(fetchImpl.quotaCalls('reserve').length, 0);
  assert.equal(fetchImpl.eventsCalls().length, 0);
  assert.equal(p.el('statusForm').textContent, '終了時刻は開始時刻より後にしてください');
});

test('startSearch: 時間帯が所要時間より短ければ quota を予約せず、エラーを表示する', async () => {
  const { page: p, fetchImpl } = searchPage({ from: '13:00', to: '13:30', duration: '45' });
  await p.call('startSearch');
  assert.equal(fetchImpl.quotaCalls('reserve').length, 0);
  assert.equal(p.el('statusForm').textContent, '時間帯が希望する空き時間より短いため検索できません');
});

test('startSearch: 正しい時間帯なら検索し、結果は時間帯の内側だけ', async () => {
  const { page: p, fetchImpl } = searchPage({
    from: '13:00', to: '18:00', duration: '45',
    items: [{ start: { dateTime: at(14) }, end: { dateTime: at(17, 15) } }],
  });
  await p.call('startSearch');
  assert.equal(fetchImpl.quotaCalls('reserve').length, 1);
  // 17:15-18:00 はちょうど 45 分なので採用。18:00 以降は時間帯の外なので出ない。
  assert.deepEqual(shape(p.run('currentSlots')), ['13:00-14:00', '17:15-18:00']);
});

test('fetchAndCalc: 18:00〜22:00 を選ぶと、それより前の空きは結果に入らない', async () => {
  const { page: p } = searchPage({ from: '18:00', to: '22:00', duration: '60' });
  const r = await p.call('fetchAndCalc');
  assert.equal(r.success, true);
  assert.deepEqual(shape(p.run('currentSlots')), ['18:00-22:00']);
});

test('goToNextWeek: 時間帯が不正なら quota を予約せず、トーストで理由を出す', async () => {
  const { page: p, fetchImpl } = searchPage({ from: '18:00', to: '13:00' });
  await p.call('goToNextWeek');
  assert.equal(fetchImpl.quotaCalls('reserve').length, 0);
  assert.equal(p.el('toast').textContent, '終了時刻は開始時刻より後にしてください');
  assert.equal(p.el('startDate').value, `${Y}-06-01`, '日付は動かさない');
});
