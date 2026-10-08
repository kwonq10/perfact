// =========================================================
// public/index.html の「保存した条件（検索条件のプリセット）」テスト
//
//   - 保存先は localStorage だけ。日付は保存しない。カレンダー ID は平文で保存しない。
//   - 呼び出すとフォームへ入れるだけで、検索は実行しない。
//   - 上限 10 件、名前は必須・20 文字まで、削除は 2 段階。
//   - localStorage が壊れていても・使えなくても画面と検索本体は壊れない。
//
//   スタブ DOM の上で動かす。ネットワークへは出ない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { jsonResponse, loadPage, makeFetch } from './page-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(HERE, '..', '..', 'public', 'index.html'), 'utf8');
const KEY = 'sukima_search_presets_v1';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** カレンダーの照合（SHA-256）は非同期なので、期待した状態になるまで最大 1 秒待つ。 */
async function waitUntil(fn, ms = 1000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * フォームを持つページ。カレンダーのチェックボックスはスタブ DOM に無いので、
 * #calList の querySelectorAll だけフェイクの checkbox を返すようにする。
 */
function formPage({ calendars = null } = {}) {
  const fetchImpl = makeFetch([]);
  const p = loadPage({ fetchImpl });
  p.run(`
    window.__boxes = [];
    (() => {
      const orig = document.querySelectorAll;
      document.querySelectorAll = (sel) => {
        if (sel === '#calList input[type=checkbox]:checked') return window.__boxes.filter(b => b.checked);
        if (sel === '#calList input[type=checkbox]') return window.__boxes;
        return orig(sel);
      };
    })();
  `);
  if (calendars) setCalendars(p, calendars);
  p.el('startDate').value = '2036-06-02';
  p.el('endDate').value = '2036-06-08';
  p.el('duration').value = '60';
  p.el('timeFrom').value = '09:00';
  p.el('timeTo').value = '22:00';
  return { page: p, fetchImpl };
}

/** カレンダー一覧を「読み込み済み」にする。checked: 初期チェック状態。 */
function setCalendars(p, cals) {
  p.run(`
    calendarList = ${JSON.stringify(cals.map((c) => ({ id: c.id, summary: c.id })))};
    window.__boxes = ${JSON.stringify(cals.map((c) => ({ value: c.id, checked: c.checked !== false })))};
  `);
}

const checkedIds = (p) => Array.from(p.run('window.__boxes.filter(b => b.checked).map(b => b.value)'));

async function save(p, name) {
  p.el('presetNameInput').value = name;
  return p.call('saveCurrentPreset');
}

const stored = (p) => p.run(`localStorage.getItem('${KEY}')`);
const presets = (p) => Array.from(p.call('readSearchPresets'));
const chips = (p) => Array.from(p.el('presetsList').children);
const chipName = (chip) => chip.children[0].children[0].textContent;
const chipSummary = (chip) => chip.children[0].children[1].textContent;
const message = (p) => p.el('presetMessage').textContent;

// =========================================================
// 保存と呼び出し
// =========================================================

test('現在の条件を名前付きで保存できる', async () => {
  const { page: p } = formPage();
  assert.equal(await save(p, '商談'), true);
  const list = presets(p);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '商談');
  assert.equal(message(p), '「商談」を保存しました');
  assert.equal(chips(p).length, 1);
  assert.equal(chipName(chips(p)[0]), '商談');
});

test('所要時間 45 分を保存し、呼び出すとフォームに戻る', async () => {
  const { page: p } = formPage();
  p.el('duration').value = '45';
  await save(p, '短め');
  p.el('duration').value = '120';
  p.call('applySearchPreset', presets(p)[0].id);
  assert.equal(p.el('duration').value, '45');
});

test('時間帯 13:00〜18:00 を保存し、呼び出すとフォームに戻る', async () => {
  const { page: p } = formPage();
  p.el('timeFrom').value = '13:00';
  p.el('timeTo').value = '18:00';
  await save(p, '午後');
  p.el('timeFrom').value = '09:00';
  p.el('timeTo').value = '22:00';
  p.call('applySearchPreset', presets(p)[0].id);
  assert.equal(p.el('timeFrom').value, '13:00');
  assert.equal(p.el('timeTo').value, '18:00');
});

test('一覧には名前と条件の要約が出る', async () => {
  const { page: p } = formPage();
  p.el('duration').value = '45';
  p.el('timeFrom').value = '13:00';
  p.el('timeTo').value = '18:00';
  await save(p, '商談');
  assert.equal(chipSummary(chips(p)[0]), '45分・13:00〜18:00');
});

test('カレンダー選択（選んで使う + チェック状態）を保存・復元できる', async () => {
  const { page: p } = formPage({ calendars: [{ id: 'a@example.com' }, { id: 'b@example.com', checked: false }, { id: 'c-team@group.calendar.google.com' }] });
  p.run("calMode = 'select';");
  await save(p, '選択');
  assert.equal(presets(p)[0].calMode, 'select');
  assert.equal(presets(p)[0].cals.length, 2);
  assert.match(chipSummary(chips(p)[0]), /選んだカレンダー$/);

  // 全部チェックし直して「全カレンダー」に戻してから呼び出す
  p.run("window.__boxes.forEach(b => { b.checked = true; }); calMode = 'all';");
  p.call('applySearchPreset', presets(p)[0].id);
  await waitUntil(() => checkedIds(p).length === 2);
  assert.equal(p.run('calMode'), 'select');
  assert.deepEqual(checkedIds(p), ['a@example.com', 'c-team@group.calendar.google.com']);
});

test('「全カレンダー」で保存した条件は全カレンダーに戻す', async () => {
  const { page: p } = formPage();
  await save(p, '全部');
  p.run("calMode = 'select';");
  p.call('applySearchPreset', presets(p)[0].id);
  assert.equal(p.run('calMode'), 'all');
});

test('カレンダー ID（メールアドレス）は平文で保存しない', async () => {
  const { page: p } = formPage({ calendars: [{ id: 'someone.private@example.com' }] });
  p.run("calMode = 'select';");
  await save(p, '選択');
  const raw = stored(p);
  assert.doesNotMatch(raw, /someone\.private|example\.com/);
  assert.match(raw, /"cals":\["[0-9a-f]{16}"\]/);
});

test('一覧の読み込み前に呼び出しても、読み込み後にカレンダー選択を反映する', async () => {
  const { page: p } = formPage({ calendars: [{ id: 'a@example.com', checked: false }, { id: 'b@example.com' }] });
  p.run("calMode = 'select';");
  await save(p, '後から');
  // 一覧が未取得の状態（例: 再読み込み直後）にする
  p.run("calendarList = []; window.__boxes = []; calMode = 'all';");
  p.call('applySearchPreset', presets(p)[0].id);
  assert.ok(p.run('pendingPresetCalHashes'), '反映待ちになる');
  // 一覧を読み込んだ（renderCalendarList が呼ばれた）
  setCalendars(p, [{ id: 'a@example.com' }, { id: 'b@example.com' }]);
  p.call('renderCalendarList');
  await waitUntil(() => JSON.stringify(checkedIds(p)) === JSON.stringify(['b@example.com']));
  assert.deepEqual(checkedIds(p), ['b@example.com']);
  assert.equal(p.run('pendingPresetCalHashes'), null);
});

test('存在しなくなったカレンダーが含まれていても壊れず、今あるものだけ反映する', async () => {
  const { page: p } = formPage({ calendars: [{ id: 'gone@example.com' }, { id: 'keep@example.com' }] });
  p.run("calMode = 'select';");
  await save(p, '一部消えた');
  setCalendars(p, [{ id: 'keep@example.com' }, { id: 'new@example.com' }]);
  p.call('applySearchPreset', presets(p)[0].id);
  await waitUntil(() => JSON.stringify(checkedIds(p)) === JSON.stringify(['keep@example.com']));
  assert.deepEqual(checkedIds(p), ['keep@example.com']);
});

test('保存したカレンダーが 1 つも無くなっていたら、現在のチェック状態を変えない', async () => {
  const { page: p } = formPage({ calendars: [{ id: 'gone@example.com' }] });
  p.run("calMode = 'select';");
  await save(p, '全部消えた');
  setCalendars(p, [{ id: 'x@example.com' }, { id: 'y@example.com', checked: false }]);
  p.call('applySearchPreset', presets(p)[0].id);
  // 「変わらないこと」の確認なので、照合が終わるだけの時間を待ってから見る
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(checkedIds(p), ['x@example.com'], '全部外して検索できなくすることはしない');
});

test('日付は保存せず、呼び出しても上書きしない', async () => {
  const { page: p } = formPage();
  await save(p, '日付なし');
  assert.doesNotMatch(stored(p), /2036-06|startDate|endDate/);
  p.el('startDate').value = '2036-07-01';
  p.el('endDate').value = '2036-07-07';
  p.call('applySearchPreset', presets(p)[0].id);
  assert.equal(p.el('startDate').value, '2036-07-01');
  assert.equal(p.el('endDate').value, '2036-07-07');
});

test('呼び出しても検索は自動実行しない（通信も quota も使わない）', async () => {
  const { page: p, fetchImpl } = formPage();
  await save(p, '検索しない');
  p.run('sukimaAuthenticated = true; accessToken = "t";');
  const before = fetchImpl.calls.length;
  p.call('applySearchPreset', presets(p)[0].id);
  await tick();
  assert.equal(fetchImpl.calls.length, before);
  assert.equal(p.run('isSearching'), false);
  assert.equal(message(p), '「検索しない」の条件を入れました。内容を確認して検索してください');
});

test('複数の条件を保存でき、保存順に並ぶ', async () => {
  const { page: p } = formPage();
  await save(p, '商談');
  p.el('duration').value = '30';
  await save(p, 'オンライン相談');
  assert.deepEqual(chips(p).map(chipName), ['商談', 'オンライン相談']);
});

// =========================================================
// 入力チェック・上限・削除
// =========================================================

test('名前が空なら保存しない', async () => {
  const { page: p } = formPage();
  assert.equal(await save(p, '   '), false);
  assert.equal(presets(p).length, 0);
  assert.equal(message(p), '名前を入力してください');
});

test('名前が 20 文字を超えたら保存しない（20 文字ちょうどは保存できる）', async () => {
  const { page: p } = formPage();
  assert.equal(await save(p, 'あ'.repeat(21)), false);
  assert.equal(message(p), '名前は20文字以内にしてください');
  assert.equal(await save(p, 'あ'.repeat(20)), true);
});

test('名前入力欄は maxlength=20 を持つ', () => {
  assert.match(HTML, /<input type="text" id="presetNameInput" maxlength="20"/);
});

test('不正な時間帯（開始 >= 終了）のままでは保存しない', async () => {
  const { page: p } = formPage();
  p.el('timeFrom').value = '18:00';
  p.el('timeTo').value = '13:00';
  assert.equal(await save(p, 'だめ'), false);
  assert.equal(message(p), '終了時刻は開始時刻より後にしてください');
});

test('上限（10 件）を超えて保存できず、案内を出す', async () => {
  const { page: p } = formPage();
  for (let i = 1; i <= 10; i++) assert.equal(await save(p, `条件${i}`), true);
  assert.equal(await save(p, '11件目'), false);
  assert.equal(presets(p).length, 10);
  assert.equal(message(p), '保存できるのは10件までです。不要な条件を削除してから保存してください');
});

test('削除は 2 段階（1 回目は確認表示だけ、2 回目で削除）', async () => {
  const { page: p } = formPage();
  await save(p, '消す');
  await save(p, '残す');
  const id = presets(p)[0].id;

  assert.equal(p.call('requestDeleteSearchPreset', id), false);
  assert.equal(presets(p).length, 2, '1 回目では消えない');
  const delBtn = chips(p)[0].children[1];
  assert.equal(delBtn.textContent, '削除');
  assert.equal(delBtn.className, 'preset-delete is-confirming');

  assert.equal(p.call('requestDeleteSearchPreset', id), true);
  assert.deepEqual(presets(p).map((x) => x.name), ['残す']);
  assert.equal(message(p), '「消す」を削除しました');
});

test('別の条件の削除ボタンを押すと、前の確認表示は取り消される', async () => {
  const { page: p } = formPage();
  await save(p, 'A');
  await save(p, 'B');
  const [a, b] = presets(p).map((x) => x.id);
  p.call('requestDeleteSearchPreset', a);
  p.call('requestDeleteSearchPreset', b);
  assert.equal(presets(p).length, 2);
  assert.equal(chips(p)[0].children[1].textContent, '×');
  assert.equal(chips(p)[1].children[1].textContent, '削除');
  p.call('resetPresetDeleteConfirm');
});

test('削除ボタンと呼び出しボタンはボタン要素で、操作が結び付いている', async () => {
  const { page: p } = formPage();
  p.el('duration').value = '45';
  await save(p, 'ボタン');
  const chip = chips(p)[0];
  assert.equal(chip.children[0].type, 'button');
  assert.equal(chip.children[1].type, 'button');
  p.el('duration').value = '60';
  chip.children[0].onclick();
  assert.equal(p.el('duration').value, '45');
});

// =========================================================
// 壊れたデータ・localStorage が使えない環境
// =========================================================

test('localStorage の値が JSON でなくても壊れず 0 件', () => {
  const { page: p } = formPage();
  p.run(`localStorage.setItem('${KEY}', '{not json');`);
  assert.deepEqual(presets(p), []);
  p.call('renderSearchPresets');
  assert.equal(chips(p).length, 0);
});

test('配列でない値・不正な要素は捨て、正しい要素だけ表示する', () => {
  const { page: p } = formPage();
  p.run(`localStorage.setItem('${KEY}', JSON.stringify({ name: 'obj' }));`);
  assert.deepEqual(presets(p), []);
  p.run(`localStorage.setItem('${KEY}', JSON.stringify([
    null, 1, 'x',
    { id: 'a', name: '', duration: 60, timeFrom: '09:00', timeTo: '22:00' },
    { id: 'b', name: 'bad duration', duration: 999, timeFrom: '09:00', timeTo: '22:00' },
    { id: 'c', name: 'bad range', duration: 60, timeFrom: '18:00', timeTo: '13:00' },
    { id: 'd', name: 'bad time', duration: 60, timeFrom: '25:00', timeTo: '26:00' },
    { id: 'e', name: 'ok', duration: 45, timeFrom: '13:00', timeTo: '18:00', calMode: 'select', cals: ['zz', 123, '0123456789abcdef'] },
  ]));`);
  const list = presets(p);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'ok');
  assert.deepEqual(Array.from(list[0].cals), ['0123456789abcdef'], '形式の違うハッシュは捨てる');
  p.call('renderSearchPresets');
  assert.deepEqual(chips(p).map(chipName), ['ok']);
});

test('localStorage が使えなくても画面は壊れず、保存できない旨を出す', async () => {
  const { page: p } = formPage();
  p.run(`
    localStorage.getItem = () => { throw new Error('denied'); };
    localStorage.setItem = () => { throw new Error('denied'); };
  `);
  assert.deepEqual(presets(p), []);
  p.call('renderSearchPresets');
  assert.equal(await save(p, '保存不可'), false);
  assert.equal(message(p), 'この端末・ブラウザでは条件を保存できません');
  // 検索フォーム側の処理は従来どおり動く
  assert.equal(p.call('validateSearchTimeRange', 60), null);
});

test('localStorage が使えなくても検索（fetchAndCalc）は動く', async () => {
  const fetchImpl = makeFetch([
    [(u) => u.includes('/users/me/calendarList'), () => jsonResponse(200, { items: [{ id: 'primary' }] })],
    [(u) => u.includes('/events?'), () => jsonResponse(200, { items: [] })],
  ]);
  const p = loadPage({ fetchImpl });
  p.run(`
    localStorage.getItem = () => { throw new Error('denied'); };
    sukimaAuthenticated = true; accessToken = 't'; tokenClient = { requestAccessToken() {} };
    calMode = 'select'; calendarList = [{ id: 'primary' }];
  `);
  p.el('startDate').value = '2036-06-02';
  p.el('endDate').value = '2036-06-02';
  p.el('duration').value = '60';
  const r = await p.call('fetchAndCalc');
  assert.equal(r.success, true);
});

test('検索結果の復元（sessionStorage）とは別のキーを使う', async () => {
  const { page: p } = formPage();
  await save(p, '分離');
  assert.equal(p.run("sessionStorage.getItem('sukima_search_presets_v1')"), null);
  assert.equal(p.run("localStorage.getItem('last_result')"), null);
  assert.notEqual(p.run('SEARCH_PRESETS_KEY'), p.run('RESULT_KEY'));
});

// =========================================================
// 表示の安全性・言語
// =========================================================

test('名前は HTML として解釈しない（textContent で表示する）', async () => {
  const { page: p } = formPage();
  const evil = '<b onclick=x>&"</b>'; // 19 文字（上限 20 文字以内）の HTML 断片
  assert.ok(Array.from(evil).length <= 20);
  assert.equal(await save(p, evil), true);
  const chip = chips(p)[0];
  assert.equal(chipName(chip), evil);
  assert.equal(p.el('presetsList').innerHTML, '', '一覧に innerHTML で文字列を入れていない');
  assert.equal(chip.children[0].getAttribute('aria-label'), `「${evil}」の条件をフォームに入れる`);
});

test('英語表示では英語の文言になる', async () => {
  const { page: p } = formPage();
  p.el('duration').value = '45';
  p.el('timeFrom').value = '13:00';
  p.el('timeTo').value = '18:00';
  await save(p, 'Sales');
  p.run("currentLang = 'en';");
  p.call('applySearchPresetsLang');
  assert.equal(p.el('presetsTitle').textContent, 'Saved searches (1)');
  assert.equal(p.el('presetSaveOpenBtn').textContent, '+ Save current conditions');
  assert.equal(p.el('presetNameInput').getAttribute('placeholder'), 'Name (e.g. Sales call)');
  assert.equal(chipSummary(chips(p)[0]), '45 min・13:00〜18:00');
  assert.equal(chips(p)[0].children[1].getAttribute('aria-label'), 'Delete "Sales"');
  p.call('applySearchPreset', presets(p)[0].id);
  assert.equal(message(p), 'Applied "Sales". Check the conditions, then search.');
});

test('日本語表示の固定文言', () => {
  const { page: p } = formPage();
  p.call('applySearchPresetsLang');
  assert.equal(p.el('presetsTitle').textContent, '保存した条件（0）');
  assert.equal(p.el('presetSaveOpenBtn').textContent, '＋ 現在の条件を保存');
  assert.equal(p.el('presetSaveBtn').textContent, '保存');
  assert.equal(p.el('presetSaveCancelBtn').textContent, 'キャンセル');
});

// =========================================================
// 既存機能への影響
// =========================================================

test('プリセット欄に <label> を置かない（既存ラベルの訳し分けの順番を崩さない）', () => {
  const start = HTML.indexOf('id="searchPresets"');
  const end = HTML.indexOf('id="openBgSettingsBtn"');
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(HTML.slice(start, end), /<label/);
});

test('一覧は横並び・横スクロールで、件数が増えても縦に伸びない', () => {
  const i = HTML.indexOf('.presets-list {');
  const rule = HTML.slice(i, HTML.indexOf('}', i));
  assert.match(rule, /display: flex/);
  assert.match(rule, /overflow-x: auto/);
});

test('一覧の右端に余白があり、最後のチップは右端基準で止まる（削除ボタンが切れない）', () => {
  const list = HTML.slice(HTML.indexOf('.presets-list {'), HTML.indexOf('}', HTML.indexOf('.presets-list {')));
  assert.match(list, /scroll-padding-inline-end: 12px/);
  assert.match(HTML, /\.presets-list::after \{ content: ''; flex: 0 0 4px; \}/, 'gap 8px と合わせて 12px の余白');
  assert.match(HTML, /\.preset-chip:last-child \{ scroll-snap-align: end; \}/);
});

test('呼び出しボタンと削除ボタンは 44px 以上の大きさ', () => {
  const apply = HTML.slice(HTML.indexOf('.preset-apply {'), HTML.indexOf('}', HTML.indexOf('.preset-apply {')));
  const del = HTML.slice(HTML.indexOf('.preset-delete {'), HTML.indexOf('}', HTML.indexOf('.preset-delete {')));
  assert.match(apply, /min-height: 52px/);
  assert.match(del, /min-width: 44px/);
});

test('呼び出し後も週間カレンダー・日別表示は従来どおり描ける', async () => {
  const { page: p } = formPage();
  p.el('duration').value = '45';
  await save(p, '週間');
  p.call('applySearchPreset', presets(p)[0].id);
  p.run(`
    currentSlots = findFreeSlots('2036-06-02', '2036-06-03', 45, [], 13 * 60, 18 * 60);
    currentDailyResults = buildDailyResults(currentSlots, '2036-06-02', '2036-06-03');
    currentDayIndex = 0;
  `);
  const html = p.run('renderDailyResultHtml()');
  assert.match(html, /data-weekly-calendar/);
  assert.match(html, /data-day-card/);
  assert.match(html, /<li class="weekly-slot">13:00〜18:00<\/li>/);
});
