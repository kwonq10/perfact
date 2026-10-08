// =========================================================
// 選択アクションバー（画面下に固定の「n件選択中 / 選んだn件をコピー」）
//
//   - 0 件では出さない。1 件以上で出す。件数は全日付の合計。
//   - 日付を移動しても残る。最後の 1 件を外す・新しい検索で消える。
//   - コピー内容は従来どおり（日付順・時刻順、日付見出し付き）。
//   - 画面下の案内（更新・強制更新・インストール）が出ている間はバーを隠し、閉じたら戻す。
//     優先順位: 更新案内 > インストール案内 > 選択バー。
//   - スマホ: 下に固定・safe-area・44px・本文に下余白・トーストをバーの上へ。
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

/** 6/2 に n 件、6/3 に 2 件の結果を表示したページ。 */
function page(n = 3, lang = 'ja') {
  const p = loadPage({ fetchImpl: makeFetch([]) });
  p.run(`
    currentLang = '${lang}';
    window.matchMedia = () => ({ matches: true });
    var __copied = [];
    navigator.clipboard.writeText = async (text) => { __copied.push(text); };
    const __slots = [];
    for (let i = 0; i < ${n}; i++) __slots.push({ start: new Date(${Y}, 5, 2, 9 + i, 0), end: new Date(${Y}, 5, 2, 9 + i, 30) });
    __slots.push({ start: new Date(${Y}, 5, 3, 13, 0), end: new Date(${Y}, 5, 3, 13, 45) });
    __slots.push({ start: new Date(${Y}, 5, 3, 16, 0), end: new Date(${Y}, 5, 3, 17, 0) });
    currentSlots = __slots;
    currentDailyResults = buildDailyResults(currentSlots, '${D1}', '${D2}');
    currentDayIndex = 0;
    renderCurrentDay();
  `);
  return p;
}

const bar = (p) => ({
  shown: p.el('selectionBar').hidden === false,
  count: p.el('selectionCount').textContent,
  label: p.el('selectionCopyBtn').textContent,
  aria: p.el('selectionCopyBtn').getAttribute('aria-label'),
});
const pick = (p, ...idx) => idx.forEach((i) => p.call('toggleSlotSelection', i));
const go = (p, key) => p.call('triggerDateNav', key);

function rule(selector) {
  const i = HTML.indexOf(`${selector} {`);
  assert.ok(i >= 0, `${selector} の CSS が無い`);
  return HTML.slice(i, HTML.indexOf('}', i));
}

// =========================================================
// 表示条件と件数
// =========================================================

test('0 件では選択バーを出さない', () => {
  assert.equal(bar(page()).shown, false);
});

test('1 件選ぶと「1件選択中 / 選んだ1件をコピー」を出す', () => {
  const p = page();
  pick(p, 0);
  assert.deepEqual(bar(p), { shown: true, count: '1件選択中', label: '選んだ1件をコピー', aria: '選んだ1件の空き時間をコピー' });
});

test('3 件選ぶと「3件選択中 / 選んだ3件をコピー」', () => {
  const p = page();
  pick(p, 0, 1, 2);
  assert.equal(bar(p).count, '3件選択中');
  assert.equal(bar(p).label, '選んだ3件をコピー');
});

test('別の日へ移動してもバーは残り、件数は全日付の合計になる', () => {
  const p = page();
  pick(p, 0, 2);
  go(p, D2);
  assert.equal(bar(p).shown, true);
  assert.equal(bar(p).count, '2件選択中');
  pick(p, 0);
  assert.equal(bar(p).count, '3件選択中');
});

test('最後の 1 件を外した瞬間にバーが消える', () => {
  const p = page();
  pick(p, 1);
  pick(p, 1);
  assert.equal(bar(p).shown, false);
  assert.equal(p.el('resultView').classList.contains('has-selection-bar'), false);
  assert.equal(p.run("document.body.classList.contains('has-selection-bar')"), false);
});

test('新しい検索を実行すると選択と一緒にバーも消える', async () => {
  const at = (h) => new Date(Y, 5, 2, h, 0).toISOString();
  const fetchImpl = makeFetch([
    [(u) => u.includes('/users/me/calendarList'), () => jsonResponse(200, { items: [{ id: 'primary' }] })],
    [(u) => u.includes('/events?'), () => jsonResponse(200, { items: [{ start: { dateTime: at(9) }, end: { dateTime: at(10) } }] })],
  ]);
  const p = loadPage({ fetchImpl });
  p.run("window.matchMedia = () => ({ matches: true }); sukimaAuthenticated = true; accessToken = 't'; tokenClient = { requestAccessToken() {} }; calMode = 'select'; calendarList = [{ id: 'primary' }];");
  p.el('startDate').value = D1;
  p.el('endDate').value = D1;
  p.el('duration').value = '60';
  await p.call('fetchAndCalc');
  pick(p, 0);
  assert.equal(bar(p).shown, true);
  await p.call('fetchAndCalc');
  assert.equal(bar(p).shown, false);
});

test('13 件ある日でもバーが出て、コピー内容は従来どおり（日付順・時刻順・見出し付き）', async () => {
  const p = page(13);
  pick(p, 12, 0, 6);
  go(p, D2);
  pick(p, 1);
  assert.equal(bar(p).count, '4件選択中');
  // バーのボタンが既存のコピー処理を呼ぶ
  assert.match(HTML, /<button type="button" class="selection-copy-btn" id="selectionCopyBtn" onclick="copySelectedSlots\(\)"><\/button>/);
  p.call('copySelectedSlots');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(Array.from(p.run('__copied')), ['6/2（月）\n09:00〜09:30\n15:00〜15:30\n21:00〜21:30\n\n6/3（火）\n16:00〜17:00']);
});

test('英語表示（単数・複数）', () => {
  const p = page(3, 'en');
  pick(p, 0);
  assert.deepEqual(bar(p), { shown: true, count: '1 selected', label: 'Copy 1 selected time', aria: 'Copy the 1 selected free time' });
  pick(p, 1, 2);
  assert.equal(bar(p).count, '3 selected');
  assert.equal(bar(p).label, 'Copy 3 selected times');
  assert.equal(bar(p).aria, 'Copy the 3 selected free times');
});

test('言語を切り替えるとバーの文言も変わる', () => {
  const p = page();
  pick(p, 0, 1);
  p.run("currentLang = 'en'; applyLang();");
  assert.equal(bar(p).count, '2 selected');
  assert.equal(p.el('selectionBar').getAttribute('aria-label'), 'Selected free times');
});

test('結果画面から検索画面へ戻るとバーを隠し（選択は残る）、戻れば再び出す', () => {
  const p = page();
  pick(p, 0);
  p.call('showSearch');
  assert.equal(bar(p).shown, false);
  assert.equal(p.run("document.body.classList.contains('has-selection-bar')"), false, 'トースト位置も戻す');
  assert.equal(p.run('selectedSlotKeys.size'), 1);
  p.call('renderCurrentDay');
  assert.equal(bar(p).shown, true);
});

// =========================================================
// 画面下の案内との競合（更新 > インストール > 選択バー）
// =========================================================

test('更新案内が出たらバーを隠し、「あとで」で閉じたら戻す', () => {
  const p = page();
  pick(p, 0);
  p.run(`
    swUpdateState.currentVersion = '1.3.0';
    swUpdateState.waiting = { postMessage() {} };
    swUpdateState.updateAvailable = true;
    latestVersionInfo = { version: '1.4.0', minimumVersion: '1.0.0' };
    evaluateUpdateState();
  `);
  assert.equal(p.el('updateBanner').style.display, 'block');
  assert.equal(bar(p).shown, false, '更新案内が優先');
  p.call('dismissUpdate');
  assert.equal(bar(p).shown, true);
});

test('更新案内が出ている間に選び直しても、バーは出さない', () => {
  const p = page();
  p.run("updateUiMode = 'normal';");
  pick(p, 0);
  assert.equal(bar(p).shown, false);
});

test('強制更新中はバーを出さない', () => {
  const p = page();
  pick(p, 0);
  p.run(`
    swUpdateState.currentVersion = '0.9.0';
    latestVersionInfo = { version: '1.4.0', minimumVersion: '1.0.0' };
    evaluateUpdateState();
  `);
  assert.equal(p.run('updateUiMode'), 'forced');
  assert.equal(bar(p).shown, false);
});

/** インストール案内を出せる状態（ブラウザ表示・beforeinstallprompt 済み）にする。 */
function installable(p) {
  // standalone（ホーム画面から起動）ではないブラウザ表示にする。reduced-motion だけ一致させる
  p.run("window.matchMedia = (q) => ({ matches: !/display-mode/.test(q) }); deferredPrompt = { prompt() {}, userChoice: Promise.resolve({}) };");
}
const installShown = (p) => p.el('installBanner').style.display === 'block';

test('選択中はインストール案内より選択バーを優先する（案内を出そうとしても出さない）', () => {
  const p = page();
  installable(p);
  pick(p, 0);
  p.call('maybeShowInstallBanner');
  assert.equal(installShown(p), false);
  assert.equal(bar(p).shown, true);
});

test('インストール案内の表示中に選ぶと、案内を一時的に隠して選択バーを出す（14 日の「後で」は記録しない）', () => {
  const p = page();
  installable(p);
  p.call('maybeShowInstallBanner');
  assert.equal(installShown(p), true);
  pick(p, 0);
  assert.equal(installShown(p), false);
  assert.equal(bar(p).shown, true);
  assert.equal(p.run("localStorage.getItem('sukima_install_dismissed_at')"), null);
});

test('選択が 0 件になると選択バーを消し、隠していたインストール案内を戻す', () => {
  const p = page();
  installable(p);
  p.call('maybeShowInstallBanner');
  pick(p, 0);
  pick(p, 0); // 解除して 0 件
  assert.equal(bar(p).shown, false);
  assert.equal(installShown(p), true);
});

test('結果画面を離れたときも、隠していたインストール案内を戻す', () => {
  const p = page();
  installable(p);
  p.call('maybeShowInstallBanner');
  pick(p, 0);
  p.call('showSearch');
  assert.equal(installShown(p), true);
  p.call('renderCurrentDay'); // 結果へ戻ると再び選択バーが優先
  assert.equal(bar(p).shown, true);
  assert.equal(installShown(p), false);
});

test('14 日以内に「後で」を押していれば、0 件になってもインストール案内は戻さない', () => {
  const p = page();
  installable(p);
  p.call('maybeShowInstallBanner');
  pick(p, 0);
  p.run("localStorage.setItem('sukima_install_dismissed_at', String(Date.now()));");
  pick(p, 0);
  assert.equal(installShown(p), false);
});

test('もともとインストール案内を隠していなければ、0 件になっても勝手に出さない', () => {
  const p = page();
  installable(p);
  pick(p, 0);
  pick(p, 0);
  assert.equal(installShown(p), false);
});

test('更新案内は最上位: 選択中でも更新案内が出れば選択バーもインストール案内も出さない', () => {
  const p = page();
  installable(p);
  p.call('maybeShowInstallBanner');
  pick(p, 0);
  p.run(`
    swUpdateState.currentVersion = '1.3.0';
    swUpdateState.waiting = { postMessage() {} };
    swUpdateState.updateAvailable = true;
    latestVersionInfo = { version: '1.4.0', minimumVersion: '1.0.0' };
    evaluateUpdateState();
  `);
  assert.equal(p.el('updateBanner').style.display, 'block');
  assert.equal(bar(p).shown, false);
  assert.equal(installShown(p), false);
  p.call('dismissUpdate'); // 更新案内を閉じると、選択中なので選択バーが戻る（インストール案内は出さない）
  assert.equal(bar(p).shown, true);
  assert.equal(installShown(p), false);
});

test('重なり順はトースト < 選択バー < インストール案内 < 更新案内', () => {
  const z = (sel) => Number(/z-index:\s*(\d+)/.exec(rule(sel))[1]);
  assert.ok(z('.copy-toast') < z('.selection-bar'));
  assert.ok(z('.selection-bar') < z('#installBanner'));
  assert.ok(z('#installBanner') < z('#updateBanner'));
});

// =========================================================
// スマホ表示・操作
// =========================================================

test('画面下に固定し、safe-area を考慮し、左右いっぱい（横にはみ出さない）', () => {
  const r = rule('.selection-bar');
  assert.match(r, /position: fixed; left: 0; right: 0; bottom: 0;/);
  assert.match(r, /env\(safe-area-inset-bottom, 0px\)/);
  assert.match(HTML, /\.selection-bar\[hidden\] \{ display: none; \}/);
});

test('コピーボタンは 44px 以上で、長い文言でも縮んで省略される（390px でもはみ出さない）', () => {
  const r = rule('.selection-copy-btn');
  assert.match(r, /min-height: 44px/);
  assert.match(r, /min-width: 0/);
  assert.match(r, /text-overflow: ellipsis/);
  assert.match(rule('.selection-count'), /white-space: nowrap/);
});

test('バー表示中は本文に下余白を足し、トーストをバーの上に出す（どちらも safe-area 込み）', () => {
  assert.match(HTML, /#resultView\.has-selection-bar #resultContent \{ padding-bottom: calc\(96px \+ env\(safe-area-inset-bottom, 0px\)\); \}/);
  assert.match(HTML, /body\.has-selection-bar \.copy-toast \{ bottom: calc\(84px \+ env\(safe-area-inset-bottom, 0px\)\); \}/);
  const p = page();
  pick(p, 0);
  assert.equal(p.el('resultView').classList.contains('has-selection-bar'), true);
  assert.equal(p.run("document.body.classList.contains('has-selection-bar')"), true);
});

test('アクセシビリティ: region + ラベル、件数は aria-live にしない、ボタンは focus-visible を持つ', () => {
  assert.match(HTML, /<div id="selectionBar" class="selection-bar" data-selection-bar role="region" aria-label="選んだ空き時間" hidden>/);
  const start = HTML.indexOf('id="selectionBar"');
  const markup = HTML.slice(start, HTML.indexOf('</div>', start));
  assert.doesNotMatch(markup, /aria-live/);
  assert.match(HTML, /\.selection-copy-btn:focus-visible \{ outline: 3px solid #1a1a2e;/);
});

test('バーの上では日送りスワイプを始めない', () => {
  const p = loadPage({ fetchImpl: makeFetch([]) });
  const target = { closest: (sel) => (String(sel).split(',').map((s) => s.trim()).includes('[data-selection-bar]') ? {} : null) };
  assert.equal(p.call('isSwipeExcludedTarget', target), true);
});
