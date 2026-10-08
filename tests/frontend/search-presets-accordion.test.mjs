// =========================================================
// 「保存した条件」の折りたたみ表示テスト
//
//   - 見出し（button）に件数を出し、押すと開閉する。初期状態は閉じる。
//   - aria-expanded / aria-controls を持つ。開閉状態は保存しない。
//   - 保存した直後は開く。削除すると件数がすぐ変わる。
//   - 通常の再描画（保存・削除・言語切替）で開閉状態を勝手に戻さない。
//   - 保存・呼び出し・削除の仕様は変えていない（既存テストは search-presets.test.mjs）。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPage, makeFetch } from './page-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(HERE, '..', '..', 'public', 'index.html'), 'utf8');
const KEY = 'sukima_search_presets_v1';

/** 有効なプリセットを n 件入れた状態のページ（起動時と同じく一度描画する）。 */
function pageWith(n = 0, lang = 'ja') {
  const p = loadPage({ fetchImpl: makeFetch([]) });
  const list = Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, name: `条件${i + 1}`, duration: 60, timeFrom: '09:00', timeTo: '22:00', calMode: 'all', cals: null,
  }));
  if (n > 0) p.run(`localStorage.setItem('${KEY}', ${JSON.stringify(JSON.stringify(list))});`);
  p.run(`currentLang = '${lang}';`);
  p.el('duration').value = '60';
  p.el('timeFrom').value = '09:00';
  p.el('timeTo').value = '22:00';
  p.call('renderSearchPresets');
  return p;
}

const expanded = (p) => p.el('presetsToggle').getAttribute('aria-expanded');
const isHidden = (p) => p.el('presetsBody').hidden;
const title = (p) => p.el('presetsTitle').textContent;
const press = (p) => p.call('toggleSearchPresets');

// =========================================================
// 開閉
// =========================================================

test('マークアップの初期状態は閉じている（aria-expanded=false・本文 hidden）', () => {
  assert.match(HTML, /<button type="button" class="presets-toggle" id="presetsToggle" aria-expanded="false" aria-controls="presetsBody" onclick="toggleSearchPresets\(\)">/);
  assert.match(HTML, /<div class="presets-body" id="presetsBody" hidden>/);
});

test('起動時の描画後も閉じている', () => {
  const p = pageWith(3);
  assert.equal(expanded(p), 'false');
  assert.equal(isHidden(p), true);
});

test('見出しを押すと開き、もう一度押すと閉じる（aria-expanded が切り替わる）', () => {
  const p = pageWith(3);
  press(p);
  assert.equal(expanded(p), 'true');
  assert.equal(isHidden(p), false);
  press(p);
  assert.equal(expanded(p), 'false');
  assert.equal(isHidden(p), true);
});

test('見出し全体が button で、開閉する本文を aria-controls で指す', () => {
  const start = HTML.indexOf('id="presetsToggle"');
  const end = HTML.indexOf('</button>', start);
  const btn = HTML.slice(start, end);
  assert.match(btn, /id="presetsTitle"/, '件数入りの見出し文字は button の中');
  assert.match(btn, /presets-toggle-icon" aria-hidden="true"/, 'アイコンは読み上げない');
  assert.match(HTML, /id="presetsBody"/);
});

test('通常の再描画では開閉状態をリセットしない', () => {
  const p = pageWith(2);
  press(p);
  p.call('renderSearchPresets');
  assert.equal(expanded(p), 'true');
  p.call('applySearchPresetsLang');
  assert.equal(expanded(p), 'true', '言語切替でも開いたまま');
  press(p);
  p.call('renderSearchPresets');
  assert.equal(expanded(p), 'false', '閉じた状態も保つ');
});

test('開閉状態は localStorage に保存しない（新しく開いたページは閉じた状態）', () => {
  const p = pageWith(2);
  press(p);
  const keys = p.run('Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))');
  assert.deepEqual(Array.from(keys), [KEY]);
  assert.doesNotMatch(p.run(`localStorage.getItem('${KEY}')`), /open|expanded/i);
  assert.equal(p.run('sessionStorage.length'), 0);

  // 同じ保存データで新しくページを開く
  const raw = p.run(`localStorage.getItem('${KEY}')`);
  const q = loadPage({ fetchImpl: makeFetch([]) });
  q.run(`localStorage.setItem('${KEY}', ${JSON.stringify(raw)});`);
  q.call('renderSearchPresets');
  assert.equal(expanded(q), 'false');
});

// =========================================================
// 件数
// =========================================================

test('件数を見出しに出す（0 / 1 / 3 / 10 件）', () => {
  assert.equal(title(pageWith(0)), '保存した条件（0）');
  assert.equal(title(pageWith(1)), '保存した条件（1）');
  assert.equal(title(pageWith(3)), '保存した条件（3）');
  assert.equal(title(pageWith(10)), '保存した条件（10）');
});

test('0 件でも開けて「＋ 現在の条件を保存」を使える', () => {
  const p = pageWith(0);
  press(p);
  assert.equal(isHidden(p), false);
  p.call('openPresetSaveForm');
  assert.equal(p.el('presetSaveForm').style.display, 'block');
});

test('英語では「Saved searches (n)」', () => {
  assert.equal(title(pageWith(0, 'en')), 'Saved searches (0)');
  assert.equal(title(pageWith(3, 'en')), 'Saved searches (3)');
});

test('言語切替に追従する', () => {
  const p = pageWith(3);
  p.run("currentLang = 'en';");
  p.call('applySearchPresetsLang');
  assert.equal(title(p), 'Saved searches (3)');
  p.run("currentLang = 'ja';");
  p.call('applySearchPresetsLang');
  assert.equal(title(p), '保存した条件（3）');
});

// =========================================================
// 保存・削除・呼び出しとの連動
// =========================================================

test('保存すると件数が増え、保存直後は一覧が開く', async () => {
  const p = pageWith(2);
  assert.equal(expanded(p), 'false');
  p.el('presetNameInput').value = '新しい条件';
  assert.equal(await p.call('saveCurrentPreset'), true);
  assert.equal(title(p), '保存した条件（3）');
  assert.equal(expanded(p), 'true');
  assert.equal(isHidden(p), false);
});

test('保存に失敗したときは開閉状態を変えない', async () => {
  const p = pageWith(10);
  p.el('presetNameInput').value = '11件目';
  assert.equal(await p.call('saveCurrentPreset'), false);
  assert.equal(title(p), '保存した条件（10）');
  assert.equal(expanded(p), 'false');
});

test('削除すると見出しの件数がすぐ減る（2 段階削除は維持）', () => {
  const p = pageWith(3);
  press(p);
  assert.equal(p.call('requestDeleteSearchPreset', 'p1'), false, '1 回目は確認表示だけ');
  assert.equal(title(p), '保存した条件（3）');
  assert.equal(p.call('requestDeleteSearchPreset', 'p1'), true);
  assert.equal(title(p), '保存した条件（2）');
  assert.equal(expanded(p), 'true', '削除後も開いたまま');
});

test('呼び出しは従来どおり（45 分・13:00〜18:00 を復元し、一覧は開いたまま）', async () => {
  const p = pageWith(0);
  p.el('duration').value = '45';
  p.el('timeFrom').value = '13:00';
  p.el('timeTo').value = '18:00';
  p.el('presetNameInput').value = '午後45';
  await p.call('saveCurrentPreset');
  p.el('duration').value = '120';
  p.el('timeFrom').value = '06:00';
  p.el('timeTo').value = '23:30';
  const id = p.call('readSearchPresets')[0].id;
  p.call('applySearchPreset', id);
  assert.equal(p.el('duration').value, '45');
  assert.equal(p.el('timeFrom').value, '13:00');
  assert.equal(p.el('timeTo').value, '18:00');
  assert.equal(expanded(p), 'true');
});

test('カレンダー選択の復元も従来どおり', async () => {
  const p = pageWith(0);
  p.run(`
    window.__boxes = [{ value: 'a@example.com', checked: true }, { value: 'b@example.com', checked: false }];
    (() => {
      const orig = document.querySelectorAll;
      document.querySelectorAll = (sel) => {
        if (sel === '#calList input[type=checkbox]:checked') return window.__boxes.filter(b => b.checked);
        if (sel === '#calList input[type=checkbox]') return window.__boxes;
        return orig(sel);
      };
    })();
    calendarList = [{ id: 'a@example.com' }, { id: 'b@example.com' }];
    calMode = 'select';
  `);
  p.el('presetNameInput').value = 'Aだけ';
  await p.call('saveCurrentPreset');
  p.run("window.__boxes.forEach(b => { b.checked = true; }); calMode = 'all';");
  p.call('applySearchPreset', p.call('readSearchPresets')[0].id);
  const until = Date.now() + 1000;
  while (Date.now() < until && p.run('window.__boxes[1].checked')) await new Promise((r) => setTimeout(r, 5));
  assert.equal(p.run('calMode'), 'select');
  assert.deepEqual(Array.from(p.run('window.__boxes.map(b => b.checked)')), [true, false]);
});

// =========================================================
// CSS（スマホ表示）
// =========================================================

function rule(selector) {
  const i = HTML.indexOf(`${selector} {`);
  assert.ok(i >= 0, `${selector} の CSS が無い`);
  return HTML.slice(i, HTML.indexOf('}', i));
}

test('見出しは 44px 以上のタップ領域で、横幅いっぱい', () => {
  const r = rule('.presets-toggle');
  assert.match(r, /min-height: 44px/);
  assert.match(r, /width: 100%/);
});

test('閉じているときは本文を表示しない', () => {
  assert.match(HTML, /\.presets-body\[hidden\] \{ display: none; \}/);
});

test('開閉アイコンは短いアニメーションだけ（0.15 秒）', () => {
  assert.match(rule('.presets-toggle-icon'), /transition: transform 0\.15s ease/);
  assert.match(HTML, /\.presets-toggle\[aria-expanded="true"\] \.presets-toggle-icon \{ transform: rotate\(180deg\); \}/);
});

test('右端チップの修正（余白・右端基準のスナップ・横スクロール）は維持', () => {
  const list = rule('.presets-list');
  assert.match(list, /overflow-x: auto/);
  assert.match(list, /scroll-snap-type: x proximity/);
  assert.match(list, /scroll-padding-inline-end: 12px/);
  assert.match(HTML, /\.presets-list::after \{ content: ''; flex: 0 0 4px; \}/);
  assert.match(HTML, /\.preset-chip:last-child \{ scroll-snap-align: end; \}/);
});
