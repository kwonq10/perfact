// =========================================================
// 週間カレンダーの修正 2 件のテスト
//
//   1. 高さ: 1 日の表示は 4 件まで。5 件以上は「+N件」/「+N more」にまとめる。
//      列の高さは最も長い列に揃えない（align-items: flex-start）。
//      空き時間のデータ自体は削らず、日別カードには全件出る。
//   2. 横位置: 同じ検索結果の中の移動（日付タップ・日送り）では横位置を保ち、
//      新しい検索（条件を変えた再検索を含む）では先頭へ戻す。
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
const D1 = `${Y}-06-02`;
const D2 = `${Y}-06-03`;
const D3 = `${Y}-06-04`;

// =========================================================
// 1. 高さ: 表示件数の上限
// =========================================================

/** 6/2 に 30 分の空きを n 件持つ 1 日分の結果を作って描く。 */
function pageWithSlotCount(n, lang = 'ja') {
  const p = loadPage({ fetchImpl: OK_FETCH });
  p.run(`
    currentLang = '${lang}';
    const __slots = [];
    for (let i = 0; i < ${n}; i++) {
      __slots.push({ start: new Date(${Y}, 5, 2, 9 + i, 0), end: new Date(${Y}, 5, 2, 9 + i, 30) });
    }
    currentSlots = __slots;
    currentDailyResults = buildDailyResults(currentSlots, '${D1}', '${D2}');
    currentDayIndex = 0;
  `);
  return p;
}

const weekly = (p) => p.run('renderWeeklyCalendar(currentDailyResults, currentDayIndex)');
const firstColumn = (html) => String(html).split('data-weekly-day="')[1];
const shownTimes = (col) => Array.from(col.matchAll(/<li class="weekly-slot">([^<]+)<\/li>/g), (x) => x[1]);
const moreLabel = (col) => (/<li class="weekly-more">([^<]+)<\/li>/.exec(col) || [])[1];
const cardTimes = (html) => {
  const card = String(html).slice(String(html).indexOf('data-day-card'));
  return Array.from(card.matchAll(/<div class="slot-time">([^<]+)<span>〜<\/span>([^<]+)<\/div>/g), (x) => `${x[1]}〜${x[2]}`);
};

test('空きが 4 件以下ならそのまま全件表示し、「+N件」は出さない', () => {
  for (const n of [1, 3, 4]) {
    const col = firstColumn(weekly(pageWithSlotCount(n)));
    assert.equal(shownTimes(col).length, n, `${n} 件`);
    assert.equal(moreLabel(col), undefined, `${n} 件で +N は出ない`);
  }
});

test('空きが 5 件なら 4 件＋「+1件」', () => {
  const col = firstColumn(weekly(pageWithSlotCount(5)));
  assert.deepEqual(shownTimes(col), ['09:00〜09:30', '10:00〜10:30', '11:00〜11:30', '12:00〜12:30']);
  assert.equal(moreLabel(col), '+1件');
});

test('空きが 13 件なら 4 件＋「+9件」', () => {
  const col = firstColumn(weekly(pageWithSlotCount(13)));
  assert.equal(shownTimes(col).length, 4);
  assert.equal(moreLabel(col), '+9件');
});

test('英語では「+1 more」「+9 more」', () => {
  assert.equal(moreLabel(firstColumn(weekly(pageWithSlotCount(5, 'en')))), '+1 more');
  assert.equal(moreLabel(firstColumn(weekly(pageWithSlotCount(13, 'en')))), '+9 more');
});

test('空きなしの日は従来どおり「空き時間なし」（+N は出ない）', () => {
  const html = weekly(pageWithSlotCount(13));
  const second = String(html).split('data-weekly-day="')[2];
  assert.match(second, /<div class="weekly-empty">空き時間なし<\/div>/);
  assert.equal(moreLabel(second), undefined);
});

test('空き時間のデータ自体は削らない（currentDailyResults は 13 件のまま）', () => {
  const p = pageWithSlotCount(13);
  weekly(p);
  assert.equal(p.run('currentDailyResults[0].slots.length'), 13);
});

test('下の日別詳細カードには 13 件すべて出る', () => {
  const html = pageWithSlotCount(13).run('renderDailyResultHtml()');
  assert.equal(cardTimes(html).length, 13);
  assert.equal(cardTimes(html)[12], '21:00〜21:30');
});

test('日付タップで 13 件の日へ切り替えても、詳細カードには全件出る', () => {
  const p = pageWithSlotCount(13);
  p.run('window.matchMedia = () => ({ matches: true }); currentDayIndex = 1; renderCurrentDay();');
  p.call('triggerDateNav', D1);
  assert.equal(p.run('currentDayIndex'), 0);
  assert.equal(cardTimes(p.el('resultContent').innerHTML).length, 13);
});

test('各列の高さを最も長い列に揃えない（align-items: flex-start）', () => {
  const i = HTML.indexOf('.weekly-calendar {');
  const rule = HTML.slice(i, HTML.indexOf('}', i));
  assert.match(rule, /align-items: flex-start/);
});

test('表示件数の上限は 4 件', () => {
  assert.equal(loadPage({ fetchImpl: OK_FETCH }).run('WEEKLY_MAX_SLOTS'), 4);
});

// =========================================================
// 2. 横位置: 同じ結果の中では保ち、新しい検索では先頭へ戻す
// =========================================================

/** 6/2: 2 枠 / 6/3: 2 枠（うち 45 分 1 枠）/ 6/4: 空きなし */
const at = (d, h, mi = 0) => new Date(Y, 5, d, h, mi).toISOString();
const ITEMS = [
  [at(2, 9), at(2, 10)], [at(2, 11), at(2, 14)], [at(2, 15), at(2, 22)],
  [at(3, 9), at(3, 13)], [at(3, 13, 45), at(3, 16)], [at(3, 17), at(3, 22)],
  [at(4, 0), at(5, 0)],
].map(([s, e]) => ({ start: { dateTime: s }, end: { dateTime: e } }));

/**
 * 検索できる状態のページ。週間カレンダー要素は「描き直すたびに新しい要素になる」
 * フェイクに差し替える（スタブ DOM は HTML を解釈しないため）。
 */
function searchPage() {
  const fetchImpl = makeFetch([
    [(u) => u.includes('/users/me/calendarList'), () => jsonResponse(200, { items: [{ id: 'primary' }] })],
    [(u) => u.includes('/events?'), () => jsonResponse(200, { items: ITEMS })],
  ]);
  const p = loadPage({ fetchImpl });
  p.run(`
    window.matchMedia = () => ({ matches: true });
    sukimaAuthenticated = true; accessToken = 'test-token'; tokenClient = { requestAccessToken() {} };
    calMode = 'select'; calendarList = [{ id: 'primary' }];
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
        return orig(sel);
      };
    })();
  `);
  p.el('startDate').value = D1;
  p.el('endDate').value = D3;
  p.el('duration').value = '30';
  p.el('timeFrom').value = '09:00';
  p.el('timeTo').value = '22:00';
  return p;
}

const scrollLeft = (p) => p.run("document.querySelector('[data-weekly-calendar]').scrollLeft");
const scrollTo = (p, x) => p.run(`document.querySelector('[data-weekly-calendar]').scrollLeft = ${x};`);
const currentKey = (p) => (/class="weekly-day[^"]*is-current[^"]*" data-weekly-day="([^"]+)"/.exec(p.el('resultContent').innerHTML) || [])[1];

test('同じ検索結果の中の日付タップでは横位置を保つ', async () => {
  const p = searchPage();
  await p.call('fetchAndCalc');
  scrollTo(p, 240);
  p.call('triggerDateNav', D3);
  assert.equal(scrollLeft(p), 240);
});

test('日送りスワイプでも横位置を保つ', async () => {
  const p = searchPage();
  await p.call('fetchAndCalc');
  scrollTo(p, 240);
  p.run("animateDayChange('next', getDayCardEl());");
  assert.equal(p.run('currentDayIndex'), 1);
  assert.equal(scrollLeft(p), 240);
});

test('新しい検索（同じ条件で再検索）を実行すると横位置は先頭へ戻る', async () => {
  const p = searchPage();
  await p.call('fetchAndCalc');
  scrollTo(p, 240);
  await p.call('fetchAndCalc');
  assert.equal(scrollLeft(p), 0);
});

test('所要時間だけ変えて再検索しても先頭へ戻る', async () => {
  const p = searchPage();
  await p.call('fetchAndCalc');
  scrollTo(p, 240);
  p.el('duration').value = '45';
  await p.call('fetchAndCalc');
  assert.equal(scrollLeft(p), 0);
});

test('時間帯だけ変えて再検索しても先頭へ戻る', async () => {
  const p = searchPage();
  await p.call('fetchAndCalc');
  scrollTo(p, 240);
  p.el('timeFrom').value = '13:00';
  p.el('timeTo').value = '18:00';
  await p.call('fetchAndCalc');
  assert.equal(scrollLeft(p), 0);
});

test('再検索後は 1 日目が選択中で、その列が先頭（画面外に残らない）', async () => {
  const p = searchPage();
  await p.call('fetchAndCalc');
  p.call('triggerDateNav', D3);
  scrollTo(p, 240);
  p.el('duration').value = '60';
  await p.call('fetchAndCalc');
  assert.equal(p.run('currentDayIndex'), 0);
  assert.equal(currentKey(p), D1);
  assert.equal(scrollLeft(p), 0);
});

test('同じ日付範囲でも、検索するたびに「同じ検索結果」の目印が変わる', async () => {
  // fetchAndCalc は途中で「計算中」表示に差し替えるため、上のテストはそれだけでも先頭に戻る。
  // ここでは、その中間表示に頼らず、検索ごとに目印（data-weekly-range）自体が変わることを確かめる。
  const p = searchPage();
  await p.call('fetchAndCalc');
  const first = /data-weekly-range="([^"]+)"/.exec(p.el('resultContent').innerHTML)[1];
  await p.call('fetchAndCalc');
  const second = /data-weekly-range="([^"]+)"/.exec(p.el('resultContent').innerHTML)[1];
  assert.notEqual(first, second);
  p.call('triggerDateNav', D2);
  const afterTap = /data-weekly-range="([^"]+)"/.exec(p.el('resultContent').innerHTML)[1];
  assert.equal(afterTap, second, '同じ結果の中の移動では目印は変わらない');
});

test('再検索後、その結果の中での日付タップでは再び横位置を保つ', async () => {
  const p = searchPage();
  await p.call('fetchAndCalc');
  scrollTo(p, 240);
  await p.call('fetchAndCalc');
  scrollTo(p, 120);
  p.call('triggerDateNav', D2);
  assert.equal(scrollLeft(p), 120);
});
