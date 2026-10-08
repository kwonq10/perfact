// =========================================================
// 「選んだ空き時間だけまとめてコピー」（日付をまたいだ選択）と、
// プリセット名入力欄の値保持のテスト
//
//   選択コピー:
//     - 日別カードの各空き時間を選べる（行のどこでも・チェックボックスでも）。複数選択可。
//     - 選択は同じ検索結果の中で日付をまたいで保持する（日付タップ・日送り・言語切替・
//       再描画では消さない）。新しい検索を実行したときだけ全部消す。
//     - ボタンは全日付の合計件数: 0 件で無効「空き時間を選んでください」、n 件で「選んだn件をコピー」。
//     - コピー内容は日付順 → 時刻順。日付見出しは日ごとに 1 回、その下に時刻。日の区切りは空行。
//         ja: 6/2（月）  en: Mon, Jun 2
//     - 週間カレンダーで「+N件」に省略された分も日別カードから選べる。
//     - 既存の 1 件コピー・予定を追加・「この日をコピー」は残す。
//     - Clipboard API が無いときは既存と同じく「コピーできませんでした」。
//
//   プリセット名入力欄:
//     - 入力中の値を、再描画・言語切替・開閉で上書きしない。
//
//   未来日だけを使い、ネットワークへは出ない。2036-06-02 は月曜。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { jsonResponse, loadPage, makeFetch } from './page-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(HERE, '..', '..', 'public', 'index.html'), 'utf8');
const Y = 2036;
const D1 = `${Y}-06-02`; // 月
const D2 = `${Y}-06-03`; // 火
const D3 = `${Y}-06-04`; // 水（空きなし）

/** 6/2 に n 件（2 件目だけ 45 分）、6/3 に 2 件、6/4 に 0 件の結果を持つページ。 */
function pageWithDays(n = 3, lang = 'ja') {
  const p = loadPage({ fetchImpl: makeFetch([]) });
  p.run(`
    currentLang = '${lang}';
    window.matchMedia = () => ({ matches: true });
    var __copied = [];
    navigator.clipboard.writeText = async (text) => { __copied.push(text); };
    const __slots = [];
    for (let i = 0; i < ${n}; i++) {
      __slots.push({ start: new Date(${Y}, 5, 2, 9 + i, 0), end: new Date(${Y}, 5, 2, 9 + i, i === 1 ? 45 : 30) });
    }
    __slots.push({ start: new Date(${Y}, 5, 3, 13, 0), end: new Date(${Y}, 5, 3, 13, 45) });
    __slots.push({ start: new Date(${Y}, 5, 3, 16, 0), end: new Date(${Y}, 5, 3, 17, 0) });
    currentSlots = __slots;
    currentDailyResults = buildDailyResults(currentSlots, '${D1}', '${D3}');
    currentDayIndex = 0;
    renderCurrentDay();
  `);
  return p;
}

/** 選択状態を反映した日別カードの HTML（描き直して取る）。 */
const cardNow = (p) => {
  const h = p.run('renderDailyResultHtml()');
  return h.slice(h.indexOf('data-day-card'));
};
const copyBtn = (c) => (/<button type="button" class="btn-copy-times" id="copySelectedBtn" onclick="copySelectedSlots\(\)"( disabled)?>([^<]*)<\/button>/.exec(c) || []);
const copied = (p) => Array.from(p.run('__copied'));
const flush = () => new Promise((r) => setTimeout(r, 0));
const keys = (p) => Array.from(p.run('Array.from(selectedSlotKeys)')).sort();
const checkedRows = (c) => Array.from(c.matchAll(/<div class="day-slot-row is-selected" data-slot-index="(\d+)"/g), (m) => Number(m[1]));
const go = (p, key) => p.call('triggerDateNav', key);

// =========================================================
// 選択 UI
// =========================================================

test('各空き時間に選択用のチェックボックス（role=checkbox・44px）がある', () => {
  const c = cardNow(pageWithDays(3));
  const boxes = c.match(/<button type="button" class="slot-select" role="checkbox" aria-checked="false" aria-label="[^"]+" onclick="toggleSlotSelection\(\d+\)">/g) || [];
  assert.equal(boxes.length, 3);
  assert.match(c, /aria-label="09:00〜09:30 を選ぶ"/);
  const i = HTML.indexOf('.slot-select {');
  assert.match(HTML.slice(i, HTML.indexOf('}', i)), /width: 44px; height: 44px/);
});

test('行（時刻の文字を含む）を押しても選択でき、もう一度押すと解除される', () => {
  const p = pageWithDays(3);
  const ev = `({ target: { closest: () => null } })`;
  p.run(`handleSlotRowClick(${ev}, 1)`);
  assert.deepEqual(keys(p), [`${D1}#1`]);
  p.run(`handleSlotRowClick(${ev}, 1)`);
  assert.deepEqual(keys(p), []);
});

test('行の中のコピー・予定追加ボタンやチェックボックス自身の押下では、行の処理で二重に切り替えない', () => {
  const p = pageWithDays(3);
  const ev = (cls) => `({ target: { closest: (s) => (s.split(',').map(x => x.trim()).includes('${cls}') ? {} : null) } })`;
  p.run(`handleSlotRowClick(${ev('.slot-actions')}, 0)`);
  p.run(`handleSlotRowClick(${ev('.slot-select')}, 0)`);
  assert.deepEqual(keys(p), []);
});

test('選択中の行は is-selected と aria-checked=true で分かる', () => {
  const p = pageWithDays(3);
  p.call('toggleSlotSelection', 2);
  const c = cardNow(p);
  assert.deepEqual(checkedRows(c), [2]);
  assert.match(c, /aria-checked="true" aria-label="11:00〜11:30 を選ぶ"/);
});

// =========================================================
// 日付をまたいだ選択
// =========================================================

test('1 日目で 2 件 → 2 日目へ移動しても 2 件保持 → 2 日目で 1 件追加して合計 3 件', () => {
  const p = pageWithDays(3);
  p.call('toggleSlotSelection', 0);
  p.call('toggleSlotSelection', 2);
  assert.equal(copyBtn(cardNow(p))[2], '選んだ2件をコピー');
  go(p, D2);
  assert.deepEqual(keys(p), [`${D1}#0`, `${D1}#2`], '日付タップでは消えない');
  assert.equal(copyBtn(cardNow(p))[2], '選んだ2件をコピー', '他の日の選択も件数に入る');
  assert.deepEqual(checkedRows(cardNow(p)), [], '2 日目の行はまだ未選択');
  p.call('toggleSlotSelection', 1);
  assert.equal(copyBtn(cardNow(p))[2], '選んだ3件をコピー');
});

test('1 日目へ戻ると 2 件がチェック済みで表示され、1 件解除すると合計 2 件', () => {
  const p = pageWithDays(3);
  p.call('toggleSlotSelection', 0);
  p.call('toggleSlotSelection', 2);
  go(p, D2);
  p.call('toggleSlotSelection', 1);
  go(p, D1);
  assert.deepEqual(checkedRows(cardNow(p)), [0, 2]);
  p.call('toggleSlotSelection', 0);
  assert.equal(copyBtn(cardNow(p))[2], '選んだ2件をコピー');
  assert.deepEqual(keys(p), [`${D1}#2`, `${D2}#1`]);
});

test('日送りスワイプでも選択は消えない', () => {
  const p = pageWithDays(3);
  p.call('toggleSlotSelection', 0);
  p.run("animateDayChange('next', getDayCardEl());");
  assert.equal(p.run('currentDayIndex'), 1);
  assert.deepEqual(keys(p), [`${D1}#0`]);
  p.run("animateDayChange('previous', getDayCardEl());");
  assert.deepEqual(checkedRows(cardNow(p)), [0]);
});

test('言語切替・同じ結果の再描画では選択を保つ', () => {
  const p = pageWithDays(3);
  p.call('toggleSlotSelection', 1);
  p.run("currentLang = 'en'; renderCurrentDay(); currentLang = 'ja'; renderCurrentDay();");
  assert.deepEqual(keys(p), [`${D1}#1`]);
});

test('空き 0 件の日でも、他の日で選んでいればコピーボタンを出す（選択 UI は出さない）', () => {
  const p = pageWithDays(3);
  go(p, D3);
  assert.doesNotMatch(cardNow(p), /copySelectedBtn|slot-select/, '何も選んでいなければ出さない');
  go(p, D1);
  p.call('toggleSlotSelection', 0);
  go(p, D3);
  const c = cardNow(p);
  assert.match(c, /空き時間なし/);
  assert.doesNotMatch(c, /slot-select/);
  assert.equal(copyBtn(c)[2], '選んだ1件をコピー');
});

// =========================================================
// ボタンの表示
// =========================================================

test('0 件選択: ボタンは無効で「空き時間を選んでください」', () => {
  const b = copyBtn(cardNow(pageWithDays(3)));
  assert.equal(b[1], ' disabled');
  assert.equal(b[2], '空き時間を選んでください');
});

test('1 件 / 3 件選択の文言', () => {
  const p = pageWithDays(5);
  p.call('toggleSlotSelection', 0);
  assert.equal(copyBtn(cardNow(p))[1], undefined, '有効');
  assert.equal(copyBtn(cardNow(p))[2], '選んだ1件をコピー');
  [2, 4].forEach((i) => p.call('toggleSlotSelection', i));
  assert.equal(copyBtn(cardNow(p))[2], '選んだ3件をコピー');
});

test('英語表示の文言', () => {
  const p = pageWithDays(3, 'en');
  assert.equal(copyBtn(cardNow(p))[2], 'Select free times to copy');
  p.call('toggleSlotSelection', 0);
  assert.equal(copyBtn(cardNow(p))[2], 'Copy 1 selected time');
  go(p, D2);
  p.call('toggleSlotSelection', 0);
  assert.equal(copyBtn(cardNow(p))[2], 'Copy 2 selected times');
  assert.match(cardNow(p), /aria-label="Select 13:00〜13:45"/);
});

test('旧「この日の空き時間をまとめてコピー」は置き換え済み', () => {
  assert.doesNotMatch(HTML, /copyCurrentDayTimes|この日の空き時間をまとめてコピー/);
});

// =========================================================
// コピー内容
// =========================================================

test('複数日の選択は、日付ごとに見出しを 1 回付けて、日付順 → 時刻順でコピーする', async () => {
  const p = pageWithDays(3);
  // 選ぶ順はばらばら（2 日目から先に選ぶ）
  go(p, D2);
  p.call('toggleSlotSelection', 1);
  go(p, D1);
  p.call('toggleSlotSelection', 2);
  p.call('toggleSlotSelection', 0);
  p.call('copySelectedSlots');
  await flush();
  assert.deepEqual(copied(p), ['6/2（月）\n09:00〜09:30\n11:00〜11:30\n\n6/3（火）\n16:00〜17:00']);
  assert.equal(p.el('toast').textContent, '選んだ空き時間をコピーしました');
});

test('同じ日から 3 件選んだ場合も、日付は 1 回だけ', async () => {
  const p = pageWithDays(5);
  [4, 0, 2].forEach((i) => p.call('toggleSlotSelection', i));
  p.call('copySelectedSlots');
  await flush();
  const text = copied(p)[0];
  assert.equal(text, '6/2（月）\n09:00〜09:30\n11:00〜11:30\n13:00〜13:30');
  assert.equal((text.match(/6\/2/g) || []).length, 1);
});

test('45 分の候補もそのままの時刻でコピーする', async () => {
  const p = pageWithDays(3);
  p.call('toggleSlotSelection', 1);
  p.call('copySelectedSlots');
  await flush();
  assert.deepEqual(copied(p), ['6/2（月）\n10:00〜10:45']);
});

test('英語では「Mon, Jun 2」形式の日付見出しになる', async () => {
  const p = pageWithDays(3, 'en');
  p.call('toggleSlotSelection', 0);
  go(p, D2);
  p.call('toggleSlotSelection', 0);
  p.call('copySelectedSlots');
  await flush();
  assert.deepEqual(copied(p), ['Mon, Jun 2\n09:00〜09:30\n\nTue, Jun 3\n13:00〜13:45']);
});

test('選択を解除した時間はコピーしない', async () => {
  const p = pageWithDays(3);
  [0, 1, 2].forEach((i) => p.call('toggleSlotSelection', i));
  p.call('toggleSlotSelection', 1);
  p.call('copySelectedSlots');
  await flush();
  assert.deepEqual(copied(p), ['6/2（月）\n09:00〜09:30\n11:00〜11:30']);
});

test('0 件のまま呼ばれても何もコピーしない', async () => {
  const p = pageWithDays(3);
  p.call('copySelectedSlots');
  await flush();
  assert.deepEqual(copied(p), []);
});

test('13 件ある日（週間カレンダーは +9件）でも一部だけ選べ、他の日の選択と合わせてコピーできる', async () => {
  const p = pageWithDays(13);
  assert.match(p.el('resultContent').innerHTML, /<li class="weekly-more">\+9件<\/li>/);
  assert.equal((cardNow(p).match(/class="slot-select"/g) || []).length, 13, '日別カードには 13 件すべて選択肢がある');
  [1, 7, 12].forEach((i) => p.call('toggleSlotSelection', i)); // 週間では隠れている 8・13 件目も
  go(p, D2);
  p.call('toggleSlotSelection', 0);
  assert.equal(copyBtn(cardNow(p))[2], '選んだ4件をコピー');
  p.call('copySelectedSlots');
  await flush();
  assert.deepEqual(copied(p), ['6/2（月）\n10:00〜10:45\n16:00〜16:30\n21:00〜21:30\n\n6/3（火）\n13:00〜13:45']);
});

test('Clipboard API が無いときは既存と同じく失敗を案内する', () => {
  const p = pageWithDays(3);
  p.call('toggleSlotSelection', 0);
  p.run('navigator.clipboard = undefined;');
  p.call('copySelectedSlots');
  assert.equal(p.el('toast').textContent, 'コピーできませんでした。ブラウザのクリップボード権限をご確認ください。');
});

// =========================================================
// リセット（新しい検索のときだけ）
// =========================================================

test('新しい検索を実行すると、全日付の選択がリセットされる（同じ日付範囲でも）', async () => {
  const at = (d, h) => new Date(Y, 5, d, h, 0).toISOString();
  const items = [[at(2, 9), at(2, 10)], [at(2, 11), at(2, 14)], [at(3, 9), at(3, 12)]]
    .map(([s, e]) => ({ start: { dateTime: s }, end: { dateTime: e } }));
  const fetchImpl = makeFetch([
    [(u) => u.includes('/users/me/calendarList'), () => jsonResponse(200, { items: [{ id: 'primary' }] })],
    [(u) => u.includes('/events?'), () => jsonResponse(200, { items })],
  ]);
  const p = loadPage({ fetchImpl });
  p.run("window.matchMedia = () => ({ matches: true }); sukimaAuthenticated = true; accessToken = 't'; tokenClient = { requestAccessToken() {} }; calMode = 'select'; calendarList = [{ id: 'primary' }];");
  p.el('startDate').value = D1;
  p.el('endDate').value = D2;
  p.el('duration').value = '60';
  await p.call('fetchAndCalc');
  p.call('toggleSlotSelection', 0);
  go(p, D2);
  p.call('toggleSlotSelection', 0);
  assert.equal(keys(p).length, 2);
  await p.call('fetchAndCalc');
  assert.deepEqual(keys(p), []);
  assert.equal(copyBtn(cardNow(p))[2], '空き時間を選んでください');
});

// =========================================================
// 既存機能
// =========================================================

test('既存の 1 件コピー・予定を追加・「この日をコピー」は残り、選択とは独立して動く', async () => {
  const p = pageWithDays(3);
  const c = cardNow(p);
  assert.match(c, /onclick="copySlot\(0\)"/);
  assert.match(c, /onclick="openCalendar\(0\)"/);
  assert.match(c, /onclick="copyCurrentDay\(\)"/);
  p.call('toggleSlotSelection', 2);
  p.call('copySlot', 0);
  await flush();
  assert.match(copied(p)[0], /09:00〜09:30$/, '1 件コピーは押した行の枠（選択とは無関係）');
  assert.deepEqual(keys(p), [`${D1}#2`], '1 件コピーで選択は変わらない');
});

test('既存の時刻表示（slot-time）の形は変えていない', () => {
  assert.match(cardNow(pageWithDays(2)), /<div class="slot-time">09:00<span>〜<\/span>09:30<\/div>/);
});

// =========================================================
// プリセット名入力欄: 入力中の値を上書きしない
// =========================================================

function formPage() {
  const p = loadPage({ fetchImpl: makeFetch([]) });
  p.el('duration').value = '60';
  p.el('timeFrom').value = '09:00';
  p.el('timeTo').value = '22:00';
  p.call('renderSearchPresets');
  p.call('toggleSearchPresets', true);
  p.call('openPresetSaveForm');
  return p;
}

test('入力中の名前は、一覧の再描画・言語切替・開閉で消えない', () => {
  const p = formPage();
  p.el('presetNameInput').value = '商談abc';
  p.call('renderSearchPresets');
  p.call('applySearchPresetsLang');
  p.call('toggleSearchPresets', false);
  p.call('toggleSearchPresets', true);
  p.run("currentLang = 'en'; applyLang(); currentLang = 'ja'; applyLang();");
  assert.equal(p.el('presetNameInput').value, '商談abc');
});

test('名前欄の値を消すのは「＋ 現在の条件を保存」で開いたときだけ', () => {
  const p = formPage();
  p.el('presetNameInput').value = '途中';
  p.call('openPresetSaveForm');
  assert.equal(p.el('presetNameInput').value, '', '開き直したときだけ空にする（既存仕様）');
});

test('日本語・英数字・貼り付け相当の値を、そのまま保存できる（20 文字まで）', async () => {
  for (const name of ['オンライン相談', 'Sales call 01', '貼り付けた名前（テスト）', 'a'.repeat(20)]) {
    const p = formPage();
    p.el('presetNameInput').value = name;
    assert.equal(await p.call('saveCurrentPreset'), true, name);
    assert.equal(p.call('readSearchPresets')[0].name, name.trim());
  }
});
