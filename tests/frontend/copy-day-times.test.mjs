// =========================================================
// 「この日の空き時間をまとめてコピー」と、プリセット名入力欄の値保持のテスト
//
//   まとめてコピー:
//     - 日別カードに出す。空き 0 件の日は出さない。
//     - 表示中の日の全候補（週間カレンダーで「+N件」に省略した分も含む）を、
//       時刻だけ改行区切りでコピーする。日付や文章は付けない。
//     - 既存の 1 件コピー・「この日をコピー」は残す。
//     - Clipboard API が無いときは既存と同じく「コピーできませんでした」を出す。
//
//   プリセット名入力欄:
//     - 入力中の値を、再描画・言語切替・開閉で上書きしない（実機で文字が出ない
//       不具合の切り分け用。コード側で値を消していないことを固定する）。
//
//   未来日だけを使い、ネットワークへは出ない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPage, makeFetch } from './page-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(HERE, '..', '..', 'public', 'index.html'), 'utf8');
const Y = 2036;

/** 6/2 に n 件、6/3 に 0 件の結果を持つページ。 */
function pageWithDay(n, lang = 'ja') {
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
    currentSlots = __slots;
    currentDailyResults = buildDailyResults(currentSlots, '${Y}-06-02', '${Y}-06-03');
    currentDayIndex = 0;
    renderCurrentDay();
  `);
  return p;
}

const card = (p) => {
  const h = p.el('resultContent').innerHTML;
  return h.slice(h.indexOf('data-day-card'));
};
const copied = (p) => Array.from(p.run('__copied'));
const flush = () => new Promise((r) => setTimeout(r, 0));

// =========================================================
// ボタン
// =========================================================

test('空きがある日の詳細カードに「この日の空き時間をまとめてコピー」を出す', () => {
  const c = card(pageWithDay(3));
  assert.match(c, /<button type="button" class="btn-copy-times" onclick="copyCurrentDayTimes\(\)">この日の空き時間をまとめてコピー<\/button>/);
});

test('空き 0 件の日はまとめてコピーのボタンを出さない', () => {
  const p = pageWithDay(3);
  p.call('triggerDateNav', `${Y}-06-03`);
  const c = card(p);
  assert.match(c, /空き時間なし/);
  assert.doesNotMatch(c, /btn-copy-times|copyCurrentDayTimes/);
});

test('既存の 1 件コピー・予定を追加・「この日をコピー」は残る', () => {
  const c = card(pageWithDay(2));
  assert.match(c, /onclick="copySlot\(0\)"/);
  assert.match(c, /onclick="copySlot\(1\)"/);
  assert.match(c, /onclick="openCalendar\(0\)"/);
  assert.match(c, /onclick="copyCurrentDay\(\)"/);
});

test('英語表示の文言', () => {
  assert.match(card(pageWithDay(2, 'en')), />Copy all times for this day</);
});

// =========================================================
// コピー内容
// =========================================================

test('表示中の日の空き時間を、時刻だけ改行区切りでコピーする', async () => {
  const p = pageWithDay(3);
  p.call('copyCurrentDayTimes');
  await flush();
  assert.deepEqual(copied(p), ['09:00〜09:30\n10:00〜10:45\n11:00〜11:30']);
  assert.equal(p.el('toast').textContent, 'この日の空き時間をコピーしました');
});

test('日付や文章は含めない', async () => {
  const p = pageWithDay(2);
  p.call('copyCurrentDayTimes');
  await flush();
  assert.doesNotMatch(copied(p)[0], /月|日|\(|曜|2036/);
});

test('週間カレンダーで「+9件」に省略された分も含めて 13 件すべてコピーする', async () => {
  const p = pageWithDay(13);
  assert.match(p.el('resultContent').innerHTML, /<li class="weekly-more">\+9件<\/li>/);
  p.call('copyCurrentDayTimes');
  await flush();
  const lines = copied(p)[0].split('\n');
  assert.equal(lines.length, 13);
  assert.equal(lines[0], '09:00〜09:30');
  assert.equal(lines[12], '21:00〜21:30');
});

test('日付タップで切り替えた日の内容をコピーする', async () => {
  const p = loadPage({ fetchImpl: makeFetch([]) });
  p.run(`
    window.matchMedia = () => ({ matches: true });
    var __copied = [];
    navigator.clipboard.writeText = async (text) => { __copied.push(text); };
    currentSlots = [
      { start: new Date(${Y}, 5, 2, 10, 0), end: new Date(${Y}, 5, 2, 11, 0) },
      { start: new Date(${Y}, 5, 3, 13, 0), end: new Date(${Y}, 5, 3, 13, 45) },
      { start: new Date(${Y}, 5, 3, 16, 0), end: new Date(${Y}, 5, 3, 17, 0) },
    ];
    currentDailyResults = buildDailyResults(currentSlots, '${Y}-06-02', '${Y}-06-03');
    currentDayIndex = 0;
    renderCurrentDay();
  `);
  p.call('triggerDateNav', `${Y}-06-03`);
  p.call('copyCurrentDayTimes');
  await flush();
  assert.deepEqual(copied(p), ['13:00〜13:45\n16:00〜17:00']);
});

test('空き 0 件の日に呼ばれても何もコピーしない', async () => {
  const p = pageWithDay(2);
  p.call('triggerDateNav', `${Y}-06-03`);
  p.call('copyCurrentDayTimes');
  await flush();
  assert.deepEqual(copied(p), []);
});

test('Clipboard API が無いときは既存と同じく失敗を案内する', () => {
  const p = pageWithDay(2);
  p.run('navigator.clipboard = undefined;');
  p.call('copyCurrentDayTimes');
  assert.equal(p.el('toast').textContent, 'コピーできませんでした。ブラウザのクリップボード権限をご確認ください。');
});

test('ボタンは 44px 以上の高さで横幅いっぱい', () => {
  const i = HTML.indexOf('.btn-copy-times {');
  assert.ok(i >= 0);
  const rule = HTML.slice(i, HTML.indexOf('}', i));
  assert.match(rule, /width: 100%/);
  assert.match(rule, /min-height: 44px/);
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
