// =========================================================
// アカウント削除 UI のテスト
//
//   対象: public/index.html の openAccountDeletion() / advanceAccountDeletion() /
//         confirmAccountDeletion() / revokeGoogleAccess() / clearLocalAppData()
//
//   このテストが守るもの:
//     - 2 段階の確認（注意事項 -> 最終確認）を経ないと送信しないこと
//     - キーワード入力を求めないこと
//     - 有料契約には「即時終了・日割り返金なし・契約管理からの解約・Stripe の記録は残る」を出すこと
//     - 二重送信しないこと
//     - **サーバーが 200 を返すまで、この端末のデータを消さないこと**
//     - 200 の後に localStorage / sessionStorage / IndexedDB を消すこと
//     - Google の連携解除は best-effort で、失敗しても削除完了として扱うこと
//     - 送る body は { confirm: true } だけ（ID を送らない）
//     - **状態 B（Calendar 未連携・連携切れ）でも削除・ログアウトの導線を出すこと**
//     - その導線を #formSection の外（#accountSection）に置き続けること
//       （ハーネスの DOM スタブは親子関係を持たないので、markup で検査する）
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { extractDivById, jsonResponse, loadPage, makeFetch } from './page-harness.mjs';

const DELETE_URL = '/api/account/delete';
const TEST_TOKEN = 'ya29.dummy-token-for-tests';
const INDEX_URL = new URL('../../public/index.html', import.meta.url);
const indexHtml = fs.readFileSync(INDEX_URL, 'utf8');

/**
 * ページを読み込み、ログイン済みの状態を作る。
 *   revoke: 'success' | 'fail' | 'throw' | 'absent'
 */
function setup(opts = {}) {
  const {
    deleteRes = () => jsonResponse(200, { deleted: true }),
    plan = 'web_pro',
    entitlement = { web: true, extension: false },
    token = TEST_TOKEN,
    savedToken = null,
    revoke = 'success',
    idb = true,
    lang,
  } = opts;
  const fetchImpl = makeFetch([
    [(u) => u.includes(DELETE_URL), deleteRes],
    [(u) => u.includes('/api/auth/me'), () => jsonResponse(401, { authenticated: false })],
    [(u) => u.includes('/api/user/timezone'), () => jsonResponse(200, { ok: true, display_timezone: 'Asia/Tokyo' })],
    [(u) => u.includes('/api/quota/status'), () => jsonResponse(200, { unlimited: true })],
  ]);
  const page = loadPage({ fetchImpl });
  page.run('sukimaAuthenticated = true;');
  page.run('sukimaPlanId = ' + JSON.stringify(plan) + ';');
  page.run('sukimaEntitlement = ' + JSON.stringify(entitlement) + ';');
  if (token) page.run('accessToken = ' + JSON.stringify(token) + ';');
  if (lang) page.run('currentLang = ' + JSON.stringify(lang) + ';');

  const revokeCalls = [];
  const autoSelectCalls = [];
  const oauth2 = {
    initTokenClient() { return { requestAccessToken() {} }; },
  };
  if (revoke !== 'absent') {
    oauth2.revoke = (tok, cb) => {
      revokeCalls.push(tok);
      if (revoke === 'throw') throw new Error('gis failure');
      cb(revoke === 'success' ? { successful: true } : { successful: false, error: 'invalid_token' });
    };
  }
  page.context.google = {
    accounts: {
      id: {
        disableAutoSelect() { autoSelectCalls.push(true); },
        initialize() {}, renderButton() {}, prompt() {},
      },
      oauth2,
    },
  };

  const idbCalls = [];
  if (idb) {
    page.context.indexedDB = {
      deleteDatabase(name) {
        idbCalls.push(name);
        const r = {};
        setTimeout(() => { if (r.onsuccess) r.onsuccess(); }, 0);
        return r;
      },
    };
  }

  // この端末に残っている想定のデータ。
  const ls = page.context.localStorage;
  ls.setItem('sukima_lang', lang || 'ja');
  ls.setItem('sukima_bg_position_x', '30');
  ls.setItem('sukima_bg_position_y', '70');
  ls.setItem('sukima_bg_white_range', '1');
  ls.setItem('sukima_update_skipped', '1.2.3');
  ls.setItem('sukima_install_dismissed_at', '1');
  if (savedToken) {
    ls.setItem('gtoken', savedToken);
    ls.setItem('gtoken_expiry', String(Date.now() + 3600000));
  }
  const ss = page.context.sessionStorage;
  ss.setItem('last_result', '{"x":1}');
  ss.setItem('last_slots', '[]');
  ss.setItem('last_search_range', '{}');
  ss.setItem('sukima_tz_synced', 'Asia/Tokyo');

  return { page, fetchImpl, revokeCalls, autoSelectCalls, idbCalls, ls, ss };
}

const deleteCalls = (fetchImpl) => fetchImpl.calls.filter((c) => c.url.includes(DELETE_URL));

function notesText(page) {
  return page.el('accountDeleteNotes').children.map((c) => String(c.textContent)).join('\n');
}

/** 注意事項を開いて最終確認まで進める。 */
function goToFinal(page) {
  page.call('openAccountDeletion');
  page.call('advanceAccountDeletion');
}

// ---------------------------------------------------------
// 1. 構造
// ---------------------------------------------------------

// ハーネスの DOM スタブは親子関係を持たないため、
// 「親ごと隠れて操作できない」不具合は style だけでは検出できない。
// ここだけは markup を <div> の対応を数えて検査する。

test('アカウント操作は #accountSection にまとまり、検索フォームの外側にある', () => {
  const form = extractDivById(indexHtml, 'formSection');
  const account = extractDivById(indexHtml, 'accountSection');
  const login = extractDivById(indexHtml, 'loginSection');

  assert.ok(!form.includes('id="accountSection"'), '#formSection の内側に入れない');
  assert.ok(!login.includes('id="accountSection"'), '#loginSection の内側に入れない');
  assert.ok(!account.includes('id="formSection"'), '#formSection を包まない');

  for (const id of ['loginInfo', 'logoutBtn', 'deleteAccountBtn', 'accountDeletePanel']) {
    assert.ok(account.includes('id="' + id + '"'), id + ' は #accountSection の中にある');
    assert.ok(!form.includes('id="' + id + '"'),
      id + ' が #formSection の中にあると、状態 B で親ごと隠れて操作できない');
  }

  // 検索フォーム側の要素は移動させない。
  for (const id of ['searchBtn', 'statusForm', 'planInfo', 'quotaInfo']) {
    assert.ok(form.includes('id="' + id + '"'), id + ' は #formSection に残す');
    assert.ok(!account.includes('id="' + id + '"'), id + ' を #accountSection へ持ち込まない');
  }

  assert.ok(account.indexOf('id="deleteAccountBtn"') > account.indexOf('id="logoutBtn"'),
    'logoutBtn の後にある');
  assert.ok(account.indexOf('id="accountDeletePanel"') > account.indexOf('id="deleteAccountBtn"'),
    '確認パネルは削除ボタンの後にある');
});

test('#accountSection は既定で非表示（出し入れは updateAuthUi が持つ）', () => {
  const at = indexHtml.indexOf('id="accountSection"');
  const openTag = indexHtml.slice(indexHtml.lastIndexOf('<div', at), indexHtml.indexOf('>', at) + 1);
  assert.match(openTag, /style="display:none;"/);
});

test('確認パネルはキーワード入力を求めず、id は重複しない', () => {
  const panel = extractDivById(indexHtml, 'accountDeletePanel');
  assert.doesNotMatch(panel, /<input/i, 'キーワード入力を求めない');
  for (const id of ['accountSection', 'formSection', 'loginSection', 'loginInfo', 'logoutBtn',
                    'deleteAccountBtn', 'accountDeletePanel', 'accountDeleteNextBtn',
                    'accountDeleteConfirmBtn', 'accountDeleteBackBtn', 'accountDeleteCancelBtn']) {
    assert.equal(indexHtml.split('id="' + id + '"').length, 2, id + ' は 1 つだけ');
  }
});

test('削除の文言は ja / en の両方にある', () => {
  const { page } = setup();
  const ja = page.run('Object.keys(I18N.ja).filter((k) => k.startsWith("deleteAccount"))');
  const en = page.run('Object.keys(I18N.en).filter((k) => k.startsWith("deleteAccount"))');
  assert.ok(ja.length >= 20);
  assert.deepEqual([...ja].sort(), [...en].sort());
});

/**
 * 4 状態を作って updateAuthUi を走らせる。
 *   A: session + Calendar token / B: session のみ
 *   C: Calendar token のみ      / D: どちらも無し
 */
function setState(page, state) {
  const signedIn = (state === 'A' || state === 'B');
  const token = (state === 'A' || state === 'C') ? TEST_TOKEN : null;
  page.run('sukimaAuthenticated = ' + String(signedIn) + ';');
  page.run('accessToken = ' + JSON.stringify(token) + ';');
  page.call('updateAuthUi');
  assert.equal(page.call('getAuthState'), state, '状態 ' + state + ' を作れていない');
  return page;
}

test('状態 A: 検索フォームとアカウント操作がどちらも出る', () => {
  const { page } = setup();
  setState(page, 'A');
  assert.equal(page.el('formSection').style.display, 'block');
  assert.equal(page.el('loginSection').style.display, 'none');
  assert.equal(page.el('accountSection').style.display, '');
  assert.equal(page.el('deleteAccountBtn').style.display, '');
  assert.equal(page.el('logoutBtn').style.display, '');
  assert.notEqual(page.el('loginInfo').textContent, '');
});

test('状態 B: 削除とログアウトは出るが、検索フォームは出さない', () => {
  const { page } = setup({ token: null });
  setState(page, 'B');
  assert.equal(page.el('accountSection').style.display, '', 'アカウント操作は出す');
  assert.equal(page.el('deleteAccountBtn').style.display, '');
  assert.equal(page.el('logoutBtn').style.display, '');
  assert.equal(page.el('formSection').style.display, 'none', '検索フォームは出さない');
  assert.equal(page.el('loginSection').style.display, 'block');
  assert.equal(page.el('loginBtn').style.display, '', 'Calendar 連携ボタンは従来どおり出す');
  assert.equal(page.el('gsiButton').style.display, 'none', '本人確認済みなので GIS は出さない');
  assert.notEqual(page.el('loginInfo').textContent, '');
});

test('状態 C / D: 本人確認が無ければ削除もログアウトも出さない', () => {
  for (const state of ['C', 'D']) {
    const { page } = setup();
    setState(page, state);
    assert.equal(page.el('accountSection').style.display, 'none', state);
    assert.equal(page.el('deleteAccountBtn').style.display, 'none', state);
    assert.equal(page.el('logoutBtn').style.display, 'none', state);
    assert.equal(page.el('formSection').style.display, 'none', state);
    assert.equal(page.el('loginInfo').textContent, '', state);
  }
});

test('未認証（C / D）では確認パネルを開けない', () => {
  for (const state of ['C', 'D']) {
    const { page } = setup();
    setState(page, state);
    page.call('openAccountDeletion');
    assert.equal(page.run('accountDeletionStep'), 0, state);
    // 未描画のスタブは display が undefined。'' になったら開いている。
    assert.notEqual(page.el('accountDeletePanel').style.display, '', state + ': パネルを開かない');
  }
});

test('A -> B（Calendar token だけ失効）では確認を巻き戻さない', () => {
  const { page } = setup();
  setState(page, 'A');
  page.call('openAccountDeletion');
  assert.equal(page.run('accountDeletionStep'), 1);
  setState(page, 'B');
  assert.equal(page.run('accountDeletionStep'), 1, 'Calendar が切れただけでは閉じない');
  assert.equal(page.el('accountDeletePanel').style.display, '');
  assert.equal(page.el('deleteAccountBtn').style.display, '');
});

test('本人確認が失われたら確認パネルを閉じる', () => {
  const { page } = setup();
  setState(page, 'A');
  page.call('openAccountDeletion');
  setState(page, 'D');
  assert.equal(page.run('accountDeletionStep'), 0);
  assert.equal(page.el('accountDeletePanel').style.display, 'none');
  assert.equal(page.el('deleteAccountBtn').style.display, 'none');
  assert.equal(page.el('accountSection').style.display, 'none');
});

// ---------------------------------------------------------
// 2. 2 段階の確認
// ---------------------------------------------------------

test('有料契約: 1 段目に即時終了・日割り返金なし・契約管理からの解約・記録の保持を出す', () => {
  const { page, fetchImpl } = setup();
  page.call('openAccountDeletion');
  assert.equal(page.run('accountDeletionStep'), 1);
  assert.equal(page.el('accountDeleteTitle').textContent, 'アカウントを削除しますか？');
  const text = notesText(page);
  assert.match(text, /ただちに終了/);
  assert.match(text, /日割りでの返金はありません/);
  assert.match(text, /「お支払い・契約を管理」から解約/);
  assert.match(text, /Stripeでの請求・支払いの記録/);
  assert.match(text, /規約への同意の記録は保持/);
  assert.match(text, /すべての端末でログアウト/);
  assert.equal(page.el('accountDeleteStep1').style.display, '');
  assert.equal(page.el('accountDeleteStep2').style.display, 'none');
  assert.equal(deleteCalls(fetchImpl).length, 0, '開いただけでは送信しない');
});

test('Free: 有料契約向けの注意は出さない', () => {
  const { page } = setup({ plan: 'free', entitlement: { web: false, extension: false } });
  page.call('openAccountDeletion');
  const text = notesText(page);
  assert.doesNotMatch(text, /日割り/);
  assert.doesNotMatch(text, /Stripe/);
  assert.match(text, /アカウント情報/);
  assert.match(text, /規約への同意の記録は保持/);
});

test('契約状態が不明なら有料契約向けの注意を出す側に倒す', () => {
  const { page } = setup({ plan: 'free', entitlement: null });
  page.call('openAccountDeletion');
  assert.match(notesText(page), /日割り/);
});

test('2 段目が最終確認。戻る・キャンセルで送信せずに戻れる', () => {
  const { page, fetchImpl } = setup();
  goToFinal(page);
  assert.equal(page.run('accountDeletionStep'), 2);
  assert.equal(page.el('accountDeleteTitle').textContent, '最終確認');
  assert.match(notesText(page), /取り消せません/);
  assert.equal(page.el('accountDeleteStep1').style.display, 'none');
  assert.equal(page.el('accountDeleteStep2').style.display, '');
  assert.equal(page.el('accountDeleteConfirmBtn').textContent, 'アカウントを削除する');
  page.call('backAccountDeletion');
  assert.equal(page.run('accountDeletionStep'), 1);
  page.call('closeAccountDeletion');
  assert.equal(page.run('accountDeletionStep'), 0);
  assert.equal(page.el('accountDeletePanel').style.display, 'none');
  assert.equal(deleteCalls(fetchImpl).length, 0);
});

test('最終確認を経ずに confirm しても送信しない', async () => {
  const { page, fetchImpl } = setup();
  await page.call('confirmAccountDeletion');
  page.call('openAccountDeletion');
  await page.call('confirmAccountDeletion');
  assert.equal(deleteCalls(fetchImpl).length, 0);
});

test('en の文言', () => {
  const { page } = setup({ lang: 'en' });
  page.call('openAccountDeletion');
  assert.equal(page.el('accountDeleteTitle').textContent, 'Delete your account?');
  assert.match(notesText(page), /No prorated refund/);
  assert.match(notesText(page), /"Manage billing"/);
  page.call('advanceAccountDeletion');
  assert.equal(page.el('accountDeleteConfirmBtn').textContent, 'Delete my account');
});

// ---------------------------------------------------------
// 3. 送信
// ---------------------------------------------------------

test('最終確認で POST /api/account/delete を 1 回だけ送る。body は { confirm: true } だけ', async () => {
  const { page, fetchImpl } = setup();
  goToFinal(page);
  await Promise.all([
    page.call('confirmAccountDeletion'),
    page.call('confirmAccountDeletion'),
  ]);
  const calls = deleteCalls(fetchImpl);
  assert.equal(calls.length, 1, '二重送信しない');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].init.body, '{"confirm":true}');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
});

test('送信中はボタンを無効にする', async () => {
  let release;
  const pending = new Promise((r) => { release = r; });
  const { page } = setup({ deleteRes: () => pending });
  goToFinal(page);
  const p = page.call('confirmAccountDeletion');
  assert.equal(page.el('accountDeleteConfirmBtn').disabled, true);
  assert.equal(page.el('accountDeleteBackBtn').disabled, true);
  assert.equal(page.el('logoutBtn').disabled, true);
  assert.equal(page.el('accountDeleteStatus').textContent, '削除しています…');
  release(jsonResponse(200, { deleted: true }));
  await p;
  assert.equal(page.el('accountDeleteConfirmBtn').disabled, false);
});

// ---------------------------------------------------------
// 4. 成功後の後始末
// ---------------------------------------------------------

test('成功: Google の連携解除 -> この端末のデータを消去 -> ログアウト状態へ', async () => {
  const { page, revokeCalls, autoSelectCalls, idbCalls, ls, ss } = setup();
  goToFinal(page);
  await page.call('confirmAccountDeletion');
  assert.deepEqual(revokeCalls, ['ya29.dummy-token-for-tests']);
  assert.equal(autoSelectCalls.length, 1);
  assert.deepEqual(idbCalls, ['sukima-settings']);
  assert.equal(ls.length, 0, 'localStorage を消す');
  assert.equal(ss.length, 0, 'sessionStorage を消す');
  assert.equal(page.run('sukimaAuthenticated'), false);
  assert.equal(page.run('accessToken'), null);
  assert.equal(page.run('sukimaEntitlement'), null);
  assert.equal(page.run('accountDeletionStep'), 0);
  assert.equal(page.run('bgPositionX'), 50);
  assert.equal(page.el('status').textContent,
    'アカウントを削除しました。Googleアカウントとの連携も解除しました。');
  assert.equal(page.el('accountDeletePanel').style.display, 'none');
});

test('メモリに token が無くても保存済みの token で連携解除する', async () => {
  const { page, revokeCalls } = setup({ token: null, savedToken: 'ya29.saved' });
  goToFinal(page);
  await page.call('confirmAccountDeletion');
  assert.deepEqual(revokeCalls, ['ya29.saved']);
});

test('連携解除が失敗しても削除は完了として扱い、手動での解除方法を案内する', async () => {
  for (const revoke of ['fail', 'throw', 'absent']) {
    const { page, idbCalls, ls } = setup({ revoke });
    goToFinal(page);
    await page.call('confirmAccountDeletion');
    assert.equal(ls.length, 0, revoke);
    assert.deepEqual(idbCalls, ['sukima-settings'], revoke);
    assert.equal(page.run('sukimaAuthenticated'), false, revoke);
    assert.match(page.el('status').textContent, /アカウントを削除しました/, revoke);
    assert.match(page.el('status').textContent, /myaccount\.google\.com\/permissions/, revoke);
  }
});

test('token が無ければ連携解除を呼ばず、手動での解除方法を案内する', async () => {
  const { page, revokeCalls } = setup({ token: null });
  goToFinal(page);
  await page.call('confirmAccountDeletion');
  assert.equal(revokeCalls.length, 0);
  assert.match(page.el('status').textContent, /myaccount\.google\.com\/permissions/);
});

test('IndexedDB が無い端末でも完了する', async () => {
  const { page, ls } = setup({ idb: false });
  goToFinal(page);
  await page.call('confirmAccountDeletion');
  assert.equal(ls.length, 0);
  assert.equal(page.run('sukimaAuthenticated'), false);
});

// ---------------------------------------------------------
// 5. 失敗時はこの端末のデータを消さない
// ---------------------------------------------------------

test('サーバーが失敗したら何も消さず、再試行できる状態に戻す', async () => {
  const cases = [
    [() => jsonResponse(502, { error: 'billing_cleanup_incomplete' }), 'アカウントを削除できませんでした。時間をおいてもう一度お試しください。'],
    [() => jsonResponse(500, { error: 'billing_state_unsupported' }), 'アカウントを削除できませんでした。時間をおいてもう一度お試しください。'],
    [() => jsonResponse(401, { error: 'unauthenticated' }), 'ログインが必要です。ログインしてからもう一度お試しください。'],
    [() => { throw new TypeError('network'); }, 'アカウントを削除できませんでした。時間をおいてもう一度お試しください。'],
  ];
  for (const [deleteRes, message] of cases) {
    const { page, revokeCalls, idbCalls, ls, ss } = setup({ deleteRes });
    goToFinal(page);
    await page.call('confirmAccountDeletion');
    assert.equal(revokeCalls.length, 0, message);
    assert.equal(idbCalls.length, 0, message);
    assert.equal(ls.getItem('sukima_bg_position_x'), '30', message);
    assert.equal(ss.getItem('last_result'), '{"x":1}', message);
    assert.equal(page.run('sukimaAuthenticated'), true, message);
    assert.equal(page.run('accessToken'), 'ya29.dummy-token-for-tests', message);
    assert.equal(page.run('accountDeletionStep'), 2, message);
    assert.equal(page.el('accountDeleteStatus').textContent, message);
    assert.equal(page.el('accountDeleteConfirmBtn').disabled, false, message);
    assert.equal(page.run('accountDeletionBusy'), false, message);
  }
});

test('失敗の後に再試行して成功できる', async () => {
  let n = 0;
  const { page, fetchImpl, ls } = setup({
    deleteRes: () => (++n === 1
      ? jsonResponse(502, { error: 'database_unavailable' })
      : jsonResponse(200, { deleted: true })),
  });
  goToFinal(page);
  await page.call('confirmAccountDeletion');
  assert.equal(ls.length > 0, true);
  await page.call('confirmAccountDeletion');
  assert.equal(deleteCalls(fetchImpl).length, 2);
  assert.equal(ls.length, 0);
});

// ---------------------------------------------------------
// 6. 状態 B（Calendar 未連携・連携切れ）からの削除
//
//   削除に使うのは Sukima の正規セッションだけ。
//   Google カレンダーの認可状態は削除の可否に影響しない。
// ---------------------------------------------------------

test('状態 B: 2 段階の確認を経て削除でき、送信は 1 回だけ', async () => {
  const { page, fetchImpl } = setup({ token: null });
  setState(page, 'B');
  goToFinal(page);
  await Promise.all([
    page.call('confirmAccountDeletion'),
    page.call('confirmAccountDeletion'),
  ]);
  const calls = deleteCalls(fetchImpl);
  assert.equal(calls.length, 1, '二重送信しない');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].init.body, '{"confirm":true}');
  assert.equal(calls[0].init.credentials, 'same-origin');
});

test('状態 B: 最終確認を経ずに confirm しても送信しない', async () => {
  const { page, fetchImpl } = setup({ token: null });
  setState(page, 'B');
  page.call('openAccountDeletion');
  await page.call('confirmAccountDeletion');
  assert.equal(deleteCalls(fetchImpl).length, 0);
  assert.equal(page.run('accountDeletionStep'), 1);
});

test('状態 B: token が無いので revoke を呼ばず、手動での解除方法を案内する', async () => {
  const { page, revokeCalls, ls } = setup({ token: null });
  setState(page, 'B');
  goToFinal(page);
  await page.call('confirmAccountDeletion');
  assert.equal(revokeCalls.length, 0, 'Google へは出さない');
  assert.match(page.el('status').textContent, /アカウントを削除しました/);
  assert.match(page.el('status').textContent, /myaccount\.google\.com\/permissions/);
  assert.equal(ls.length, 0, 'この端末のデータは消す');
  assert.equal(page.run('sukimaAuthenticated'), false);
});

test('状態 B: 削除完了後は #accountSection が閉じる', async () => {
  const { page } = setup({ token: null });
  setState(page, 'B');
  goToFinal(page);
  await page.call('confirmAccountDeletion');
  assert.equal(page.el('accountSection').style.display, 'none');
  assert.equal(page.el('deleteAccountBtn').style.display, 'none');
  assert.equal(page.el('logoutBtn').style.display, 'none');
  assert.equal(page.el('accountDeletePanel').style.display, 'none');
  assert.equal(page.run('accountDeletionStep'), 0);
});

test('状態 B: サーバーが失敗したらセッションもこの端末のデータも消さない', async () => {
  const { page, revokeCalls, idbCalls, ls, ss } = setup({
    token: null,
    deleteRes: () => jsonResponse(502, { error: 'database_unavailable' }),
  });
  setState(page, 'B');
  goToFinal(page);
  await page.call('confirmAccountDeletion');
  assert.equal(revokeCalls.length, 0);
  assert.equal(idbCalls.length, 0);
  // 背景位置は updateAuthUi -> applyBackgroundEntitlement が書き戻す（今回の変更と無関係の既存挙動）。
  // 削除フローが消すべきキーが残っていることで判定する。
  assert.equal(ls.getItem('sukima_update_skipped'), '1.2.3');
  assert.ok(ls.length > 0, 'localStorage を消さない');
  assert.equal(ss.getItem('last_result'), '{"x":1}');
  assert.equal(ss.getItem('sukima_tz_synced'), 'Asia/Tokyo');
  assert.equal(page.run('sukimaAuthenticated'), true, 'セッションを勝手に落とさない');
  assert.equal(page.run('accountDeletionStep'), 2, '再試行できる状態に戻す');
  assert.equal(page.el('accountSection').style.display, '', '導線は残す');
});

// ---------------------------------------------------------
// 7. 文言: Google ログイン（本人確認）と Calendar 連携の区別
// ---------------------------------------------------------

test('状態 A と状態 B で loginInfo の文言を出し分ける', () => {
  const { page } = setup();
  setState(page, 'A');
  assert.equal(page.el('loginInfo').textContent, 'Googleアカウント連携済み');
  setState(page, 'B');
  assert.equal(page.el('loginInfo').textContent, 'Googleアカウントでログイン中',
    'Calendar 未連携で「連携済み」と書くと、連携ボタンと矛盾して読める');
  setState(page, 'C');
  assert.equal(page.el('loginInfo').textContent, '');
  setState(page, 'D');
  assert.equal(page.el('loginInfo').textContent, '');
});

test('en も同様に出し分ける', () => {
  const { page } = setup({ lang: 'en' });
  setState(page, 'A');
  assert.equal(page.el('loginInfo').textContent, 'Google Account connected');
  setState(page, 'B');
  assert.equal(page.el('loginInfo').textContent, 'Signed in with Google');
});

test('signedInOnly は ja / en の両方にあり、loggedIn とは別の文言', () => {
  const { page } = setup();
  const ja = page.run('I18N.ja.signedInOnly');
  const en = page.run('I18N.en.signedInOnly');
  assert.equal(typeof ja, 'string');
  assert.equal(typeof en, 'string');
  assert.ok(ja.length > 0 && en.length > 0);
  assert.notEqual(ja, page.run('I18N.ja.loggedIn'));
  assert.notEqual(en, page.run('I18N.en.loggedIn'));
  assert.doesNotMatch(ja, /連携済み/, '状態 B の文言に「連携済み」を使わない');
});

// ---------------------------------------------------------
// 8. Web Pro（有料契約）の状態 B
//
//   契約中の利用者が Calendar 未連携でも、解約と削除の違いを
//   理解したうえで削除へ進めること。**実 API は呼ばない（fetch はスタブ）。**
// ---------------------------------------------------------

/** Web Pro かつ状態 B のページを作る。 */
function setupProStateB(opts = {}) {
  const r = setup(Object.assign({ token: null, plan: 'web_pro', entitlement: { web: true, extension: false } }, opts));
  setState(r.page, 'B');
  return r;
}

test('Web Pro / 状態 B: 削除とログアウトが出て、検索フォームは出ない', () => {
  const { page } = setupProStateB();
  assert.equal(page.el('deleteAccountBtn').style.display, '');
  assert.equal(page.el('logoutBtn').style.display, '');
  assert.equal(page.el('accountSection').style.display, '');
  assert.equal(page.el('formSection').style.display, 'none');
  assert.equal(page.el('loginBtn').style.display, '', 'Calendar 連携ボタンは出す');
});

test('Web Pro / 状態 B: 有料契約向けの注意が出る（共通 4 件 + 有料 4 件）', () => {
  const { page } = setupProStateB();
  page.call('openAccountDeletion');
  const notes = page.el('accountDeleteNotes').children.map((c) => String(c.textContent));
  assert.equal(notes.length, 8, JSON.stringify(notes));
  const all = notes.join('\n');
  assert.match(all, /ただちに終了/, '即時終了を伝える');
  assert.match(all, /日割りでの返金はありません/);
  assert.match(all, /Stripeでの請求・支払いの記録/);
  assert.match(all, /規約への同意の記録は保持されます/);
});

test('Web Pro / 状態 B: 解約と削除の違いが読み取れる', () => {
  const { page } = setupProStateB();
  page.call('openAccountDeletion');
  const notes = page.el('accountDeleteNotes').children.map((c) => String(c.textContent));
  const portal = notes.find((n) => n.includes('解約'));
  assert.ok(portal, '「削除せず解約する」選択肢を提示している: ' + JSON.stringify(notes));
  assert.match(portal, /アカウントを削除せず/, '削除しない選択肢だと分かる');
  assert.match(portal, /期間の終わりまで/, '解約なら期間末まで使えると分かる');
  assert.match(notes.join('|'), /ただちに終了/, '削除は即時終了だと分かる');
  assert.match(notes.join('|'), /日割りでの返金はありません/, '削除しても返金されないと分かる');
});

test('Free / 状態 B: 有料契約向けの注意は出さない（共通 4 件のみ）', () => {
  const { page } = setup({ token: null, plan: 'free', entitlement: { web: false, extension: false } });
  setState(page, 'B');
  page.call('openAccountDeletion');
  assert.equal(page.el('accountDeleteNotes').children.length, 4);
});

test('Web Pro / 状態 B: 送信内容は Free と同じ（認証条件を変えない）', async () => {
  const { page, fetchImpl } = setupProStateB();
  goToFinal(page);
  await page.call('confirmAccountDeletion');
  const calls = deleteCalls(fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].init.body, '{"confirm":true}', 'ID や契約情報を送らない');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
});

// ---------------------------------------------------------
// 9. 契約管理への案内と、実際の画面の整合性
//
//   注意文が指す「お支払い・契約を管理」ボタンは #planInfo に描かれ、
//   #planInfo は #formSection の中にある。つまり **状態 B の画面上には無い**。
//   代わりに「料金プラン」リンクは両セクションの外にあり、状態 B でも
//   見えるため、/pricing 経由で契約管理へ到達できる。
//   この導線が失われると案内が行き止まりになるので、構造で固定する。
// ---------------------------------------------------------

test('契約管理ボタンの置き場（#planInfo）は #formSection の中にある', () => {
  const form = extractDivById(indexHtml, 'formSection');
  const account = extractDivById(indexHtml, 'accountSection');
  assert.ok(form.includes('id="planInfo"'), '#planInfo は #formSection 内');
  assert.ok(!account.includes('id="planInfo"'));
});

test('「料金プラン」リンクは #formSection / #accountSection の外にあり、状態 B でも残る', () => {
  const form = extractDivById(indexHtml, 'formSection');
  const account = extractDivById(indexHtml, 'accountSection');
  const login = extractDivById(indexHtml, 'loginSection');
  assert.ok(!form.includes('id="searchPricingLink"'),
    '#formSection の中に入れると、状態 B で契約管理への導線が消える');
  assert.ok(!account.includes('id="searchPricingLink"'));
  assert.ok(!login.includes('id="searchPricingLink"'));
  assert.ok(indexHtml.includes('id="searchPricingLink"'));
  assert.match(indexHtml.slice(indexHtml.indexOf('id="searchPricingLink"') - 200,
                               indexHtml.indexOf('id="searchPricingLink"') + 200), /href="\/pricing"/);
});

test('有料の注意文は契約管理のラベルをそのまま引用している（文言のずれを防ぐ）', () => {
  // 状態 A / B のどちらでも、実際のボタン名をそのまま引用する。
  for (const state of ['A', 'B']) {
    const { page } = setup({ token: state === 'A' ? TEST_TOKEN : null, plan: 'web_pro', entitlement: { web: true, extension: false } });
    setState(page, state);
    page.call('openAccountDeletion');
    const notes = page.el('accountDeleteNotes').children.map((c) => String(c.textContent));
    const portal = notes.find((n) => n.includes('解約'));
    assert.ok(portal, state + ': 解約案内がある');
    assert.ok(portal.includes(page.run('I18N.ja.planManageCta')),
      state + ': 注意文のラベルと planManageCta が一致する: ' + JSON.stringify(portal));
  }
});

// ---------------------------------------------------------
// 10. 解約案内は「その画面から到達できる導線」を指す
//
//   契約管理ボタン（#planInfo）は #formSection の中にあり、状態 B の
//   画面には無い。状態 B では「料金プラン」ページ経由で案内する。
//   状態 A の文言は従来どおり維持する。
// ---------------------------------------------------------

/** 有料向けの解約案内（「解約」を含む注意）を取り出す。 */
function cancelNote(page) {
  page.call('openAccountDeletion');
  const notes = page.el('accountDeleteNotes').children.map((c) => String(c.textContent));
  return { notes, line: notes.find((n) => /解約|cancel/.test(n)) };
}

test('Web Pro / 状態 A: 従来の案内を維持する', () => {
  const { page } = setup({ plan: 'web_pro', entitlement: { web: true, extension: false } });
  setState(page, 'A');
  const { notes, line } = cancelNote(page);
  assert.equal(notes.length, 8);
  assert.equal(line, '期間の終わりまで使いたい場合は、削除せずに「お支払い・契約を管理」から解約してください。');
  assert.doesNotMatch(line, /料金プラン/, '状態 A では画面上にボタンがあるのでページ経由にしない');
});

test('Web Pro / 状態 B: 料金プランページ経由で案内する', () => {
  const { page } = setupProStateB();
  const { notes, line } = cancelNote(page);
  assert.equal(notes.length, 8, '注意の件数は状態 A と同じ');
  assert.equal(line, '期間の終わりまで利用したい場合は、アカウントを削除せず、「料金プラン」ページの「お支払い・契約を管理」から解約してください。');
  assert.match(line, /料金プラン/, '状態 B の画面から到達できる導線を指す');
  assert.match(line, /お支払い・契約を管理/, '実際のボタン名も併記する');
});

test('en: 状態 A / B で解約案内を出し分ける', () => {
  const a = setup({ plan: 'web_pro', entitlement: { web: true, extension: false }, lang: 'en' });
  setState(a.page, 'A');
  assert.equal(cancelNote(a.page).line,
    'To keep using Web Pro until the end of the period, cancel from "Manage billing" instead of deleting your account.');

  const b = setup({ token: null, plan: 'web_pro', entitlement: { web: true, extension: false }, lang: 'en' });
  setState(b.page, 'B');
  const line = cancelNote(b.page).line;
  assert.equal(line,
    'To keep using Web Pro until the end of the period, do not delete your account: cancel from "Manage billing" on the pricing page.');
  assert.match(line, /pricing page/);
});

test('deleteAccountPaidPortalViaPricing は ja / en 両方にあり、状態 A の文言とは別', () => {
  const { page } = setup();
  for (const lang of ['ja', 'en']) {
    const via = page.run('I18N.' + lang + '.deleteAccountPaidPortalViaPricing');
    const orig = page.run('I18N.' + lang + '.deleteAccountPaidPortal');
    assert.equal(typeof via, 'function', lang);
    assert.equal(typeof orig, 'function', lang);
    assert.notEqual(via('X'), orig('X'), lang + ': 状態 A と同じ文言にしない');
    assert.ok(via('X').includes('X'), lang + ': ボタン名を差し込む');
  }
});

test('Free / 状態 A・B とも解約案内を出さない', () => {
  for (const state of ['A', 'B']) {
    const { page } = setup({ token: state === 'A' ? TEST_TOKEN : null, plan: 'free', entitlement: { web: false, extension: false } });
    setState(page, state);
    const { notes, line } = cancelNote(page);
    assert.equal(notes.length, 4, state);
    assert.equal(line, undefined, state + ': 有料向けの解約案内は出さない');
  }
});

test('状態 B の案内でも削除処理と送信内容は変わらない', async () => {
  const { page, fetchImpl, revokeCalls } = setupProStateB();
  goToFinal(page);
  await page.call('confirmAccountDeletion');
  const calls = deleteCalls(fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body, '{"confirm":true}');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(revokeCalls.length, 0, 'token が無ければ revoke は呼ばない（Step 102 から不変）');
  assert.match(page.el('status').textContent, /myaccount\.google\.com\/permissions/);
});
