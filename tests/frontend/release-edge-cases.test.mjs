// =========================================================
// 本番反映前レビューで見つけた未カバーのエッジケース
//
//   既存テストで押さえていなかったもののうち、壊れたときの影響が大きいものだけ。
//   - 「今日」を含む検索: 現在時刻より前・時間帯の外を候補に出さない
//   - 検索時間帯の最大値（23:00〜23:30）の境界
//   - 週間カレンダー: 1 日だけ / 14 日間
//   - 選択コピー: 別日の同じ時刻を別々に選べる / writeText が reject しても選択は残る
//   - プリセット: 同名を複数保存して片方だけ削除 / 別タブで消された条件の呼び出し /
//     巨大な localStorage データ
//   - 検索エラー表示: 例外メッセージに HTML が混ざってもタグとして解釈しない
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { jsonResponse, loadPage, makeFetch } from './page-harness.mjs';

const OK_FETCH = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
const Y = 2036;
const KEY = 'sukima_search_presets_v1';

const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// =========================================================
// 検索
// =========================================================

test('「今日」を含む検索では、現在時刻（30 分単位で切り捨て）より前と時間帯の外を候補に出さない', () => {
  const p = loadPage({ fetchImpl: OK_FETCH });
  const today = ymd(new Date());
  for (const [from, to] of [[9 * 60, 22 * 60], [6 * 60, 23 * 60 + 30], [13 * 60, 18 * 60]]) {
    const now = new Date();
    const floorNow = Math.floor((now.getHours() * 60 + now.getMinutes()) / 30) * 30;
    const slots = Array.from(p.call('findFreeSlots', today, today, 30, [], from, to));
    for (const s of slots) {
      const startMin = s.start.getHours() * 60 + s.start.getMinutes();
      const endMin = s.end.getHours() * 60 + s.end.getMinutes();
      assert.ok(startMin >= Math.max(from, floorNow), `開始 ${hm(s.start)} が現在/時間帯より前`);
      assert.ok(endMin <= to, `終了 ${hm(s.end)} が時間帯の外`);
    }
    // 予定なしなら、残り時間が 30 分以上ある限り 1 枠になる
    const remain = to - Math.max(from, floorNow);
    assert.equal(slots.length, remain >= 30 ? 1 : 0, `from=${from} to=${to}`);
  }
});

test('検索時間帯の最大値 23:00〜23:30 でも 30 分の枠を返す（45 分は返さない）', () => {
  const p = loadPage({ fetchImpl: OK_FETCH });
  const day = `${Y}-06-02`;
  const r30 = Array.from(p.call('findFreeSlots', day, day, 30, [], 23 * 60, 23 * 60 + 30), (s) => `${hm(s.start)}-${hm(s.end)}`);
  assert.deepEqual(r30, ['23:00-23:30']);
  assert.equal(Array.from(p.call('findFreeSlots', day, day, 45, [], 23 * 60, 23 * 60 + 30)).length, 0);
});

// =========================================================
// 週間カレンダー
// =========================================================

test('週間カレンダー: 1 日だけでも 14 日間でも、日数ぶんの列を出す', () => {
  const p = loadPage({ fetchImpl: OK_FETCH });
  for (const [start, end, n] of [[`${Y}-06-02`, `${Y}-06-02`, 1], [`${Y}-06-02`, `${Y}-06-15`, 14]]) {
    p.run(`
      currentSlots = findFreeSlots('${start}', '${end}', 60, []);
      currentDailyResults = buildDailyResults(currentSlots, '${start}', '${end}');
      currentDayIndex = 0;
    `);
    const html = p.run('renderWeeklyCalendar(currentDailyResults, currentDayIndex)');
    assert.equal((html.match(/data-weekly-day="/g) || []).length, n);
    assert.equal((html.match(/data-weekly-nav="/g) || []).length, n);
  }
});

// =========================================================
// 選択コピー
// =========================================================

function selectionPage() {
  const p = loadPage({ fetchImpl: makeFetch([]) });
  p.run(`
    window.matchMedia = () => ({ matches: true });
    var __copied = [];
    navigator.clipboard.writeText = async (text) => { __copied.push(text); };
    currentSlots = [
      { start: new Date(${Y}, 5, 2, 10, 0), end: new Date(${Y}, 5, 2, 10, 30) },
      { start: new Date(${Y}, 5, 3, 10, 0), end: new Date(${Y}, 5, 3, 10, 30) },
    ];
    currentDailyResults = buildDailyResults(currentSlots, '${Y}-06-02', '${Y}-06-03');
    currentDayIndex = 0;
    renderCurrentDay();
  `);
  return p;
}

test('別の日に同じ時刻の枠があっても、別々に選べて両方コピーされる', async () => {
  const p = selectionPage();
  p.call('toggleSlotSelection', 0);
  p.call('triggerDateNav', `${Y}-06-03`);
  p.call('toggleSlotSelection', 0);
  assert.equal(p.run('selectedSlotKeys.size'), 2);
  p.call('copySelectedSlots');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(Array.from(p.run('__copied')), ['6/2（月）\n10:00〜10:30\n\n6/3（火）\n10:00〜10:30']);
});

test('writeText が reject しても失敗を案内し、選択は残る（もう一度コピーできる）', async () => {
  const p = selectionPage();
  p.call('toggleSlotSelection', 0);
  p.run("navigator.clipboard.writeText = async () => { throw new Error('NotAllowedError'); };");
  p.call('copySelectedSlots');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(p.el('toast').textContent, 'コピーできませんでした。ブラウザのクリップボード権限をご確認ください。');
  assert.equal(p.run('selectedSlotKeys.size'), 1);
});

// =========================================================
// プリセット
// =========================================================

function presetPage() {
  const p = loadPage({ fetchImpl: makeFetch([]) });
  p.el('duration').value = '60';
  p.el('timeFrom').value = '09:00';
  p.el('timeTo').value = '22:00';
  p.call('renderSearchPresets');
  return p;
}

async function save(p, name) {
  p.el('presetNameInput').value = name;
  return p.call('saveCurrentPreset');
}

test('同じ名前の条件を 2 つ保存でき、削除すると指定した 1 つだけが消える', async () => {
  const p = presetPage();
  p.el('duration').value = '30';
  await save(p, '商談');
  p.el('duration').value = '90';
  await save(p, '商談');
  const [a, b] = Array.from(p.call('readSearchPresets'));
  assert.notEqual(a.id, b.id);
  p.call('requestDeleteSearchPreset', a.id);
  p.call('requestDeleteSearchPreset', a.id);
  const left = Array.from(p.call('readSearchPresets'));
  assert.equal(left.length, 1);
  assert.equal(left[0].id, b.id);
  assert.equal(left[0].duration, 90);
});

test('別のタブで消された条件を呼び出しても壊れず、一覧を描き直す', async () => {
  const p = presetPage();
  await save(p, '消される');
  const id = p.call('readSearchPresets')[0].id;
  p.run(`localStorage.setItem('${KEY}', '[]');`); // 別タブで全削除された
  p.el('duration').value = '120';
  assert.equal(p.call('applySearchPreset', id), false);
  assert.equal(p.el('duration').value, '120', 'フォームは変えない');
  assert.equal(p.el('presetsTitle').textContent, '保存した条件（0）');
});

test('localStorage に巨大なデータを入れられても、正しい条件を上限 10 件まで読み、長すぎる名前は捨てる', () => {
  const p = presetPage();
  const big = JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({
    id: `p${i}`,
    name: i % 2 === 0 ? 'x'.repeat(10000) : `条件${i}`,
    duration: 60, timeFrom: '09:00', timeTo: '22:00', calMode: 'all',
  })));
  p.run(`localStorage.setItem('${KEY}', ${JSON.stringify(big)});`);
  const list = Array.from(p.call('readSearchPresets'));
  assert.equal(list.length, 10);
  for (const x of list) assert.ok(Array.from(x.name).length <= 20);
  p.call('renderSearchPresets');
  assert.equal(p.el('presetsList').children.length, 10);
});

// =========================================================
// 検索エラー表示
// =========================================================

test('検索中の例外メッセージに HTML が混ざっても、タグとして解釈しない', async () => {
  const fetchImpl = makeFetch([
    [(u) => u.includes('/users/me/calendarList'), () => jsonResponse(200, { items: [{ id: 'primary' }] })],
    [(u) => u.includes('/events?'), () => jsonResponse(200, { items: [] })],
  ]);
  const p = loadPage({ fetchImpl });
  p.run(`
    sukimaAuthenticated = true; accessToken = 't'; tokenClient = { requestAccessToken() {} };
    calMode = 'select'; calendarList = [{ id: 'primary' }];
    buildDailyResults = () => { throw new Error('<img src=x onerror=alert(1)>'); };
  `);
  p.el('startDate').value = `${Y}-06-02`;
  p.el('endDate').value = `${Y}-06-02`;
  p.el('duration').value = '60';
  const r = await p.call('fetchAndCalc');
  assert.equal(r.success, false);
  const html = p.el('resultContent').innerHTML;
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// =========================================================
// 予定を追加（Google カレンダーを新しいタブで開く）
// =========================================================

test('「予定を追加」は noopener,noreferrer 付きで Google カレンダーの作成画面を開く', () => {
  const p = loadPage({ fetchImpl: OK_FETCH });
  p.run(`
    var __opened = [];
    window.open = (...args) => { __opened.push(args); return null; };
    currentSlots = [{ start: new Date(${Y}, 5, 2, 10, 0), end: new Date(${Y}, 5, 2, 10, 45) }];
    currentDailyResults = buildDailyResults(currentSlots, '${Y}-06-02', '${Y}-06-02');
    currentDayIndex = 0;
  `);
  p.call('openCalendar', 0);
  const opened = Array.from(p.run('__opened'), (a) => Array.from(a));
  assert.equal(opened.length, 1);
  const [url, target, features] = opened[0];
  assert.equal(url, 'https://calendar.google.com/calendar/render?action=TEMPLATE&dates=20360602T100000/20360602T104500');
  assert.equal(target, '_blank');
  assert.equal(features, 'noopener,noreferrer');
});

test('「予定を追加」は存在しない枠では何も開かない（戻り値 null でも落ちない）', () => {
  const p = loadPage({ fetchImpl: OK_FETCH });
  p.run(`
    var __opened = [];
    window.open = (...args) => { __opened.push(args); return null; };
    currentSlots = [];
    currentDailyResults = buildDailyResults(currentSlots, '${Y}-06-02', '${Y}-06-02');
    currentDayIndex = 0;
  `);
  p.call('openCalendar', 0);
  assert.equal(p.run('__opened.length'), 0);
});

test('escapeHtml は & < > " \' をすべてエスケープする', () => {
  const p = loadPage({ fetchImpl: OK_FETCH });
  assert.equal(p.call('escapeHtml', `<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});
