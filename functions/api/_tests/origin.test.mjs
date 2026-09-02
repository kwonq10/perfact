// =========================================================
// _lib/origin.js（CSRF Origin 検証）の単体テスト
//
//   - ネットワークへは出ない。DB にも触れない。
//   - 本番の secret / token / Cookie 値はフィクスチャに一切保存しない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ALLOWED_ORIGINS,
  checkOrigin,
  getAllowedOrigins,
  normalizeOrigin,
} from '../_lib/origin.js';

const APEX = 'https://sukimacalendar.com';

/** Origin ヘッダの有無を切り替えられる Request を作る。 */
function req(origin, method = 'POST') {
  const headers = origin === undefined ? {} : { origin };
  return new Request('https://example.com/api/auth/logout', { method, headers });
}

/** env は毎回新しく作る（テスト間で共有しない）。 */
function env(allowedOrigins) {
  return allowedOrigins === undefined ? {} : { ALLOWED_ORIGINS: allowedOrigins };
}

// =========================================================
// 既定 allowlist
// =========================================================

test('既定 allowlist は本番 apex のみ', () => {
  assert.deepEqual([...DEFAULT_ALLOWED_ORIGINS], [APEX]);
});

test('既定 allowlist に www を含めない', () => {
  assert.equal(DEFAULT_ALLOWED_ORIGINS.includes('https://www.sukimacalendar.com'), false);
});

test('既定 allowlist にローカル開発 origin を含めない', () => {
  for (const local of ['http://127.0.0.1:8788', 'http://localhost:8788']) {
    assert.equal(DEFAULT_ALLOWED_ORIGINS.includes(local), false, local);
  }
});

test('getAllowedOrigins: env 未設定なら既定値', () => {
  assert.deepEqual(getAllowedOrigins({}), [APEX]);
  assert.deepEqual(getAllowedOrigins(undefined), [APEX]);
  assert.deepEqual(getAllowedOrigins(null), [APEX]);
});

// =========================================================
// normalizeOrigin（URL として解釈した正規化）
// =========================================================

test('normalizeOrigin: 大文字小文字を正規化する', () => {
  assert.equal(normalizeOrigin('HTTPS://SUKIMACALENDAR.COM'), APEX);
  assert.equal(normalizeOrigin('HtTpS://SukimaCalendar.Com'), APEX);
});

test('normalizeOrigin: 末尾スラッシュを正規化する', () => {
  assert.equal(normalizeOrigin('https://sukimacalendar.com/'), APEX);
  assert.equal(normalizeOrigin('HTTPS://SUKIMACALENDAR.COM/'), APEX);
});

test('normalizeOrigin: https の既定ポート :443 は省略される', () => {
  assert.equal(normalizeOrigin('https://sukimacalendar.com:443'), APEX);
});

test('normalizeOrigin: 非既定ポートは保持される', () => {
  assert.equal(normalizeOrigin('https://sukimacalendar.com:8443'), 'https://sukimacalendar.com:8443');
});

test('normalizeOrigin: スキームは保持される（http と https を混同しない）', () => {
  assert.equal(normalizeOrigin('http://sukimacalendar.com'), 'http://sukimacalendar.com');
  assert.notEqual(normalizeOrigin('http://sukimacalendar.com'), APEX);
});

test('normalizeOrigin: "null" は不透明 origin として null', () => {
  assert.equal(normalizeOrigin('null'), null);
});

test('normalizeOrigin: chrome-extension スキームは null', () => {
  assert.equal(normalizeOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop'), null);
});

test('normalizeOrigin: 空・空白・非 URL は null', () => {
  for (const v of ['', '   ', 'not a url', 'sukimacalendar.com', '//sukimacalendar.com']) {
    assert.equal(normalizeOrigin(v), null, JSON.stringify(v));
  }
});

test('normalizeOrigin: 文字列以外は null', () => {
  for (const v of [undefined, null, 0, 1, {}, [], true]) {
    assert.equal(normalizeOrigin(v), null, String(v));
  }
});

test('normalizeOrigin: 前後の空白を除いてから解釈する', () => {
  assert.equal(normalizeOrigin('  https://sukimacalendar.com  '), APEX);
});

// =========================================================
// checkOrigin: 許可
// =========================================================

test('本番 apex は許可', () => {
  assert.deepEqual(checkOrigin(req(APEX), env()), { ok: true });
});

test('大文字小文字が違っても許可（正規化して比較）', () => {
  assert.deepEqual(checkOrigin(req('HTTPS://SUKIMACALENDAR.COM'), env()), { ok: true });
});

test('末尾スラッシュ付きでも許可（正規化して比較）', () => {
  assert.deepEqual(checkOrigin(req('https://sukimacalendar.com/'), env()), { ok: true });
});

test('https の既定ポート指定でも許可', () => {
  assert.deepEqual(checkOrigin(req('https://sukimacalendar.com:443'), env()), { ok: true });
});

// =========================================================
// checkOrigin: 拒否
// =========================================================

test('www は拒否（308 で apex へ寄せている / __Host- Cookie も届かない）', () => {
  assert.deepEqual(checkOrigin(req('https://www.sukimacalendar.com'), env()),
    { ok: false, reason: 'forbidden_origin' });
});

test('Origin ヘッダが無ければ拒否（missing_origin）', () => {
  assert.deepEqual(checkOrigin(req(undefined), env()),
    { ok: false, reason: 'missing_origin' });
});

test('Origin が空文字・空白のみなら missing_origin', () => {
  for (const v of ['', '   ']) {
    assert.deepEqual(checkOrigin(req(v), env()),
      { ok: false, reason: 'missing_origin' }, JSON.stringify(v));
  }
});

test('Origin: null は拒否（forbidden_origin。ヘッダ自体は送られている）', () => {
  assert.deepEqual(checkOrigin(req('null'), env()),
    { ok: false, reason: 'forbidden_origin' });
});

test('http は拒否（スキーム違い）', () => {
  assert.deepEqual(checkOrigin(req('http://sukimacalendar.com'), env()),
    { ok: false, reason: 'forbidden_origin' });
});

test('ポート違いは拒否', () => {
  for (const v of ['https://sukimacalendar.com:8443', 'https://sukimacalendar.com:80']) {
    assert.deepEqual(checkOrigin(req(v), env()),
      { ok: false, reason: 'forbidden_origin' }, v);
  }
});

test('サフィックス攻撃は拒否（前方/後方一致で通さない）', () => {
  for (const v of [
    'https://sukimacalendar.com.evil.example',
    'https://evil-sukimacalendar.com',
    'https://sukimacalendar.com.co',
    'https://notsukimacalendar.com',
  ]) {
    assert.deepEqual(checkOrigin(req(v), env()),
      { ok: false, reason: 'forbidden_origin' }, v);
  }
});

test('サブドメインは拒否（allowlist は完全一致のみ）', () => {
  for (const v of ['https://api.sukimacalendar.com', 'https://a.b.sukimacalendar.com']) {
    assert.deepEqual(checkOrigin(req(v), env()),
      { ok: false, reason: 'forbidden_origin' }, v);
  }
});

test('無関係な evil origin は拒否', () => {
  assert.deepEqual(checkOrigin(req('https://evil.example'), env()),
    { ok: false, reason: 'forbidden_origin' });
});

test('chrome-extension origin は拒否（拡張は Sukima API を呼ばない）', () => {
  assert.deepEqual(checkOrigin(req('chrome-extension://abcdefghijklmnopabcdefghijklmnop'), env()),
    { ok: false, reason: 'forbidden_origin' });
});

test('解釈できない Origin は拒否', () => {
  for (const v of ['not a url', 'sukimacalendar.com', 'javascript:alert(1)']) {
    assert.deepEqual(checkOrigin(req(v), env()),
      { ok: false, reason: 'forbidden_origin' }, v);
  }
});

test('ローカル開発 origin は既定では拒否', () => {
  for (const v of ['http://127.0.0.1:8788', 'http://localhost:8788']) {
    assert.deepEqual(checkOrigin(req(v), env()),
      { ok: false, reason: 'forbidden_origin' }, v);
  }
});

// =========================================================
// ALLOWED_ORIGINS による上書き
// =========================================================

test('ALLOWED_ORIGINS は「追加」ではなく「上書き」', () => {
  const e = env('http://127.0.0.1:8788');
  assert.deepEqual(getAllowedOrigins(e), ['http://127.0.0.1:8788']);
  // 既定の apex は上書きされて許可されなくなる
  assert.deepEqual(checkOrigin(req(APEX), e), { ok: false, reason: 'forbidden_origin' });
  assert.deepEqual(checkOrigin(req('http://127.0.0.1:8788'), e), { ok: true });
});

test('ALLOWED_ORIGINS: カンマ区切りで複数指定できる', () => {
  const e = env('https://sukimacalendar.com,http://127.0.0.1:8788');
  assert.deepEqual(getAllowedOrigins(e), [APEX, 'http://127.0.0.1:8788']);
  assert.deepEqual(checkOrigin(req(APEX), e), { ok: true });
  assert.deepEqual(checkOrigin(req('http://127.0.0.1:8788'), e), { ok: true });
});

test('ALLOWED_ORIGINS: 各要素の前後空白を除いて解釈する', () => {
  const e = env('  https://sukimacalendar.com ,\thttp://127.0.0.1:8788\n');
  assert.deepEqual(getAllowedOrigins(e), [APEX, 'http://127.0.0.1:8788']);
  assert.deepEqual(checkOrigin(req(APEX), e), { ok: true });
});

test('ALLOWED_ORIGINS: 各要素も URL として正規化される', () => {
  const e = env('HTTPS://SUKIMACALENDAR.COM/,https://sukimacalendar.com:443');
  // 正規化の結果同じになるので重複は排除される
  assert.deepEqual(getAllowedOrigins(e), [APEX]);
  assert.deepEqual(checkOrigin(req(APEX), e), { ok: true });
});

test('ALLOWED_ORIGINS: 解釈できない要素は無視する（allowlist を広げない）', () => {
  const e = env('https://sukimacalendar.com,not a url,,null,chrome-extension://abc');
  assert.deepEqual(getAllowedOrigins(e), [APEX]);
  assert.deepEqual(checkOrigin(req('null'), e), { ok: false, reason: 'forbidden_origin' });
});

test('ALLOWED_ORIGINS: 空文字・空白のみは「未設定」として既定値を使う', () => {
  for (const v of ['', '   ', '\t\n']) {
    assert.deepEqual(getAllowedOrigins(env(v)), [APEX], JSON.stringify(v));
  }
});

test('ALLOWED_ORIGINS: 文字列以外は無視して既定値を使う', () => {
  for (const v of [123, {}, [], true, null]) {
    assert.deepEqual(getAllowedOrigins({ ALLOWED_ORIGINS: v }), [APEX], String(v));
  }
});

test('ALLOWED_ORIGINS: 全要素が解釈不能なら allowlist は空になり全拒否（fail closed）', () => {
  const e = env('not a url,also bad');
  assert.deepEqual(getAllowedOrigins(e), []);
  assert.deepEqual(checkOrigin(req(APEX), e), { ok: false, reason: 'forbidden_origin' });
});

// =========================================================
// 副作用・不変性
// =========================================================

test('DEFAULT_ALLOWED_ORIGINS は凍結されている', () => {
  assert.equal(Object.isFrozen(DEFAULT_ALLOWED_ORIGINS), true);
});

test('getAllowedOrigins の戻り値を書き換えても既定値は壊れない', () => {
  const first = getAllowedOrigins({});
  first.push('https://evil.example');
  assert.deepEqual(getAllowedOrigins({}), [APEX]);
});

test('checkOrigin は Response を作らず、例外も投げない', () => {
  const r = checkOrigin(req('https://evil.example'), env());
  assert.equal(r instanceof Response, false);
  assert.equal(typeof r.ok, 'boolean');
  assert.deepEqual(Object.keys(r).sort(), ['ok', 'reason']);
});

test('checkOrigin: 壊れた request でも例外を投げず missing_origin', () => {
  for (const bad of [undefined, null, {}, { headers: {} }]) {
    assert.deepEqual(checkOrigin(bad, env()), { ok: false, reason: 'missing_origin' }, String(bad));
  }
});

test('checkOrigin: GET でも判定ロジックは同じ（適用するかは呼び出し側の責務）', () => {
  assert.deepEqual(checkOrigin(req(APEX, 'GET'), env()), { ok: true });
  assert.deepEqual(checkOrigin(req('https://evil.example', 'GET'), env()),
    { ok: false, reason: 'forbidden_origin' });
});
