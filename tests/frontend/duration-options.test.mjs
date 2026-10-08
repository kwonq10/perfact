// =========================================================
// public/index.html の「希望する空き時間」（所要時間）の選択肢テスト
//
//   1. 選択肢: 30 / 45 / 60 / 90 / 120 分。既定は 60 分のまま。
//   2. 文言: 各選択肢に ja / en の訳がある（applyLanguage が option を引くため、
//      片方だけ足すと言語切替で落ちる）。
//   3. 検索: 選んだ分数以上の空きだけを返す。刻み（STEP_MIN=30）の途中で始まる
//      予定があっても、空きの終わりは予定の開始時刻まで正しく取る
//      （45 分の隙間が 30 分に縮んで落ちないこと）。
//
//   free-slots.test.mjs と同じく未来日だけを使い、ネットワークへは出ない。
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

/** 未来年。今日と重ならないので現在時刻の影響を受けない。 */
const Y = 2036;

const page = loadPage({ fetchImpl: OK_FETCH });

const find = (duration, events) =>
  page.call('findFreeSlots', `${Y}-06-01`, `${Y}-06-01`, duration, events);

/** 6/1 のローカル時刻から ISO 文字列を作る。 */
const at = (h, mi = 0) => new Date(Y, 5, 1, h, mi).toISOString();

const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const shape = (slots) => Array.from(slots, (s) => `${hm(s.start)}-${hm(s.end)}`);

/** 10:00 から gapMin 分だけ空き、前後は予定で塞がっている 1 日。 */
const gapFrom10 = (gapMin) => {
  const endMin = 10 * 60 + gapMin;
  return [
    { start: at(9, 0), end: at(10, 0) },
    { start: at(Math.floor(endMin / 60), endMin % 60), end: at(22, 0) },
  ];
};

// =========================================================
// 選択肢と文言
// =========================================================

function durationOptions() {
  const m = HTML.match(/<select id="duration">([\s\S]*?)<\/select>/);
  assert.ok(m, '#duration の select が見つからない');
  return Array.from(m[1].matchAll(/<option value="(\d+)"( selected)?>/g), (o) => ({
    value: Number(o[1]),
    selected: Boolean(o[2]),
  }));
}

test('所要時間は 30 / 45 / 60 / 90 / 120 分を短い順に並べる', () => {
  assert.deepEqual(durationOptions().map((o) => o.value), [30, 45, 60, 90, 120]);
});

test('既定の所要時間は 60 分のまま', () => {
  assert.deepEqual(durationOptions().filter((o) => o.selected).map((o) => o.value), [60]);
});

test('すべての選択肢に ja / en の文言がある', () => {
  for (const { value } of durationOptions()) {
    for (const lang of ['ja', 'en']) {
      const label = page.run(`I18N.${lang}.dur${value}`);
      assert.equal(typeof label, 'string', `I18N.${lang}.dur${value} が無い`);
      assert.ok(label.length > 0);
    }
  }
  assert.equal(page.run('I18N.ja.dur45'), '45分');
  assert.equal(page.run('I18N.en.dur45'), '45 min');
});

test('言語切替は 45 分の選択肢の文言も更新する', () => {
  assert.match(HTML, /option\[value="45"\]'\)\.textContent = t\('dur45'\)/);
});

// =========================================================
// 検索: 選んだ分数以上の空きだけを返す
// =========================================================

test('30 分を選ぶと 30 分の隙間を採用する', () => {
  assert.deepEqual(shape(find(30, gapFrom10(30))), ['10:00-10:30']);
});

test('45 分を選ぶと 30 分の隙間は採用しない', () => {
  assert.deepEqual(shape(find(45, gapFrom10(30))), []);
});

test('45 分を選ぶと、ちょうど 45 分の隙間を 10:00-10:45 として採用する', () => {
  assert.deepEqual(shape(find(45, gapFrom10(45))), ['10:00-10:45']);
});

test('45 分を選ぶと 44 分の隙間は採用しない', () => {
  assert.deepEqual(shape(find(45, gapFrom10(44))), []);
});

test('45 分を選ぶと、より長い 60 分の隙間も採用する', () => {
  assert.deepEqual(shape(find(45, gapFrom10(60))), ['10:00-11:00']);
});

test('60 分を選ぶと 45 分の隙間は採用しない', () => {
  assert.deepEqual(shape(find(60, gapFrom10(45))), []);
});

test('60 分を選ぶと、ちょうど 60 分の隙間を採用する', () => {
  assert.deepEqual(shape(find(60, gapFrom10(60))), ['10:00-11:00']);
});

test('30 分を選ぶと 45 分の隙間を切り捨てずに 10:00-10:45 で返す', () => {
  assert.deepEqual(shape(find(30, gapFrom10(45))), ['10:00-10:45']);
});

test('刻みの途中で始まる予定の直前まで空きとして返す（13:15 開始）', () => {
  assert.deepEqual(shape(find(60, [{ start: at(13, 15), end: at(14, 0) }])),
    ['09:00-13:15', '14:00-22:00']);
});

// =========================================================
// fetchAndCalc: 画面で選んだ値が検索に反映される
// =========================================================

function searchWithDuration(durationValue) {
  const items = [
    { start: { dateTime: at(9, 0) }, end: { dateTime: at(10, 0) } },
    { start: { dateTime: at(10, 45) }, end: { dateTime: at(22, 0) } },
  ];
  const fetchImpl = makeFetch([
    [(u) => u.includes('/users/me/calendarList'), () => jsonResponse(200, { items: [{ id: 'primary' }] })],
    [(u) => u.includes('/events?'), () => jsonResponse(200, { items })],
  ]);
  const p = loadPage({ fetchImpl });
  p.run("sukimaAuthenticated = true; accessToken = 'test-token'; tokenClient = { requestAccessToken() {} };");
  p.run("calMode = 'select'; calendarList = [{ id: 'primary' }];");
  p.el('startDate').value = `${Y}-06-01`;
  p.el('endDate').value = `${Y}-06-01`;
  p.el('duration').value = durationValue;
  return p;
}

test('fetchAndCalc: 45 分を選ぶと 45 分の空きが結果に入る', async () => {
  const p = searchWithDuration('45');
  const r = await p.call('fetchAndCalc');
  assert.equal(r.success, true);
  assert.deepEqual(shape(p.run('currentSlots')), ['10:00-10:45']);
});

test('fetchAndCalc: 60 分を選ぶと同じ 45 分の空きは結果に入らない', async () => {
  const p = searchWithDuration('60');
  const r = await p.call('fetchAndCalc');
  assert.equal(r.success, true);
  assert.deepEqual(shape(p.run('currentSlots')), []);
});
