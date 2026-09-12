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
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { jsonResponse, loadPage, makeFetch } from './page-harness.mjs';

const DELETE_URL = '/api/account/delete';
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
    token = 'ya29.dummy-token-for-tests',
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

test('削除ボタンと確認パネルがログイン後のフォームにあり、キーワード入力欄を持たない', () => {
  const form = indexHtml.slice(indexHtml.indexOf('id="formSection"'));
  const btnAt = form.indexOf('id="deleteAccountBtn"');
  assert.ok(btnAt > form.indexOf('id="logoutBtn"'), 'logoutBtn の後にある');
  const panelStart = indexHtml.indexOf('id="accountDeletePanel"');
  const panelEnd = indexHtml.indexOf('id="accountDeleteStatus"', panelStart);
  assert.ok(panelStart > 0 && panelEnd > panelStart);
  const panel = indexHtml.slice(panelStart, panelEnd);
  assert.doesNotMatch(panel, /<input/i, 'キーワード入力を求めない');
  for (const id of ['deleteAccountBtn', 'accountDeletePanel', 'accountDeleteNextBtn',
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

test('ログイン中だけ削除ボタンを出し、ログアウト状態では確認パネルを閉じる', () => {
  const { page } = setup();
  page.call('updateAuthUi');
  assert.equal(page.el('deleteAccountBtn').style.display, '');
  page.call('openAccountDeletion');
  assert.equal(page.el('accountDeletePanel').style.display, '');
  page.run('sukimaAuthenticated = false; accessToken = null;');
  page.call('updateAuthUi');
  assert.equal(page.el('deleteAccountBtn').style.display, 'none');
  assert.equal(page.el('accountDeletePanel').style.display, 'none');
  assert.equal(page.run('accountDeletionStep'), 0);
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
