// =========================================================
// POST /api/terms/consent の単体テスト
//
//   - **実 DB へ接続しない。** session も RPC もスタブに差し替える。
//   - **本番の SUBSCRIPTION_TERMS_CONFIG を書き換えない。**
//     本番は published なので、draft 側の fail closed は
//     `currentVersion` を注入して再現する（注入の向きが 5B-1 から逆になっただけで、
//     「本番設定をテストから触らない」という方針は変えていない）。
//   - 本番の secret / Project URL はフィクスチャに一切保存しない。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_BODY_KEYS,
  RPC_NAME,
  handleTermsConsent,
  validate,
} from '../terms/consent.js';
import { SESSION_COOKIE_NAME, SESSION_RESULT } from '../_lib/session.js';
import { SupabaseError } from '../_lib/supabase.js';
import {
  SUBSCRIPTION_TERMS_CONFIG,
  SubscriptionTermsConfigError,
} from '../_lib/billing-config.js';

const ENV = {
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dummy_for_tests_only',
};

const quiet = { error() {}, warn() {}, log() {} };

/** 本番の canonical host。_lib/origin.js の既定 allowlist と同じ値。 */
const ORIGIN = 'https://sukimacalendar.com';

/** テスト用のダミー user_id。実際の users.id ではない。 */
const USER_ID = '11111111-2222-3333-4444-555555555555';

/** 注入で使う版。**本番設定の版とは別の値**にして、取り違えを検出できるようにする。 */
const PUBLISHED_VERSION = '2026-12-01';
const ACCEPTED_AT = '2026-12-01T00:00:00.000Z';

function req({
  method = 'POST',
  body = JSON.stringify({ locale: 'ja' }),
  origin = ORIGIN,
  contentType = 'application/json',
  cookie = `${SESSION_COOKIE_NAME}=dummytoken`,
} = {}) {
  const headers = {};
  if (origin !== null) headers.origin = origin;
  if (contentType !== null) headers['content-type'] = contentType;
  if (cookie !== null) headers.cookie = cookie;
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && body !== null) init.body = body;
  return new Request('https://example.com/api/terms/consent', init);
}

function stubSession(context = { plan_id: 'free', status: 'active' }) {
  const calls = [];
  const fn = async (request, env, deps) => {
    calls.push({ request, env, deps });
    if (context && context.status && context.plan_id) {
      return { status: SESSION_RESULT.VALID, context: { user_id: USER_ID, ...context } };
    }
    return context;
  };
  fn.calls = calls;
  return fn;
}

/** RPC スタブ。既定は record_terms_consent の契約どおりの 1 行。 */
function stubRpc(rows, over = {}) {
  const value = rows ?? [{
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    terms_version: PUBLISHED_VERSION,
    locale: 'ja',
    accepted_at: ACCEPTED_AT,
    ...over,
  }];
  const calls = [];
  const fn = async (name, args, options) => {
    calls.push({ name, args, options });
    if (value instanceof Error) throw value;
    return value;
  };
  fn.calls = calls;
  return fn;
}

/** published を再現する版取得スタブ。 */
function stubVersion(version = PUBLISHED_VERSION) {
  const fn = () => {
    if (version instanceof Error) throw version;
    return version;
  };
  return fn;
}

/**
 * draft を再現した deps。
 *
 * 本番設定は published なので、**draft の挙動は注入で再現する。**
 * getCurrentSubscriptionTermsVersion() が draft のときに投げる例外と
 * 同じ形（SubscriptionTermsConfigError / code = 'not_published'）を使う。
 */
function draftDeps(over = {}) {
  return {
    session: stubSession(),
    rpc: stubRpc(),
    logger: quiet,
    currentVersion: () => {
      throw new SubscriptionTermsConfigError('not_published', 'draft');
    },
    ...over,
  };
}

/** 本番 config をそのまま使う deps（version を注入しない）。 */
function productionDeps(over = {}) {
  return {
    session: stubSession(),
    rpc: stubRpc(null, { terms_version: SUBSCRIPTION_TERMS_CONFIG.version }),
    logger: quiet,
    ...over,
  };
}

/** published を再現した deps。 */
function publishedDeps(over = {}) {
  return {
    session: stubSession(),
    rpc: stubRpc(),
    logger: quiet,
    currentVersion: stubVersion(),
    ...over,
  };
}

async function call(deps, request = req()) {
  const res = await handleTermsConsent(request, ENV, deps);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 本文が JSON でないケースも見る */ }
  return { res, body, text };
}


// =========================================================
// 1. method / Origin / session
// =========================================================

test('POST 以外は 405 で、session も RPC も触らない', async () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const deps = draftDeps();
    const { res, body } = await call(deps, req({ method }));
    assert.equal(res.status, 405, method);
    assert.deepEqual(body, { error: 'method_not_allowed' });
    assert.equal(deps.session.calls.length, 0, method + ': session を見ない');
    assert.equal(deps.rpc.calls.length, 0, method + ': RPC を呼ばない');
  }
});

test('未認証は 401 で、RPC を呼ばない', async () => {
  const deps = draftDeps({
    session: stubSession({ status: SESSION_RESULT.UNAUTHENTICATED }),
  });
  const { res, body } = await call(deps);
  assert.equal(res.status, 401);
  assert.deepEqual(body, { error: 'unauthenticated' });
  assert.equal(deps.rpc.calls.length, 0);
});

test('Origin が不正なら 403 で、session も RPC も触らない', async () => {
  for (const origin of ['https://evil.example.com', 'null', null]) {
    const deps = draftDeps();
    const { res, body } = await call(deps, req({ origin }));
    assert.equal(res.status, 403, String(origin));
    assert.deepEqual(body, { error: 'forbidden_origin' });
    assert.equal(deps.session.calls.length, 0, String(origin));
    assert.equal(deps.rpc.calls.length, 0, String(origin));
  }
});

test('正しい Origin なら Origin では弾かれない', async () => {
  const deps = publishedDeps();
  const { res } = await call(deps, req({ origin: ORIGIN }));
  assert.notEqual(res.status, 403);
  assert.equal(res.status, 200);
});


// =========================================================
// 2. body の形
// =========================================================

test('body が無い / Content-Type が JSON でないと 400', async () => {
  const noBody = await call(draftDeps(), req({ body: null }));
  assert.equal(noBody.res.status, 400);

  const noCt = await call(draftDeps(), req({ contentType: null }));
  assert.equal(noCt.res.status, 400);
  assert.deepEqual(noCt.body, { error: 'invalid_content_type' });
});

test('JSON として壊れていたら 400 malformed_json', async () => {
  const { res, body } = await call(draftDeps(), req({ body: '{locale:' }));
  assert.equal(res.status, 400);
  assert.deepEqual(body, { error: 'malformed_json' });
});

test('配列 / スカラーの body は 400 invalid_body', async () => {
  for (const raw of ['[]', '["ja"]', '"ja"', '1', 'true', 'null']) {
    const { res, body } = await call(draftDeps(), req({ body: raw }));
    assert.equal(res.status, 400, raw);
    assert.deepEqual(body, { error: 'invalid_body' }, raw);
  }
});

test('body が壊れている段階で RPC を呼ばない', async () => {
  const deps = draftDeps();
  await call(deps, req({ body: '[]' }));
  assert.equal(deps.rpc.calls.length, 0);
});


// =========================================================
// 3. locale
// =========================================================

test('locale が無ければ 400 invalid_locale', async () => {
  const { res, body } = await call(draftDeps(), req({ body: JSON.stringify({}) }));
  assert.equal(res.status, 400);
  assert.deepEqual(body, { error: 'invalid_locale' });
});

test('locale = ja / en は受理される（published 経路）', async () => {
  for (const locale of ['ja', 'en']) {
    const deps = publishedDeps({ rpc: stubRpc(null, { locale }) });
    const { res, body } = await call(deps, req({ body: JSON.stringify({ locale }) }));
    assert.equal(res.status, 200, locale);
    assert.equal(body.accepted, true, locale);
    assert.equal(body.locale, locale, locale);
  }
});

test('locale の大文字 / 未対応 / 空 / 非文字列は 400 で RPC を呼ばない', async () => {
  const bad = ['JA', 'EN', 'Ja', 'fr', 'de', 'ja-JP', 'en-US', '', ' ', ' ja', 'ja ',
               null, 0, 1, true, false, {}, []];
  for (const locale of bad) {
    const deps = publishedDeps();
    const { res, body } = await call(deps, req({ body: JSON.stringify({ locale }) }));
    assert.equal(res.status, 400, JSON.stringify(locale));
    assert.deepEqual(body, { error: 'invalid_locale' }, JSON.stringify(locale));
    assert.equal(deps.rpc.calls.length, 0, JSON.stringify(locale));
  }
});

test('validate は locale を正規化しない', () => {
  assert.deepEqual(validate({ locale: 'ja' }), { ok: true, value: { locale: 'ja' } });
  assert.deepEqual(validate({ locale: 'JA' }), { ok: false, code: 'invalid_locale' });
});


// =========================================================
// 4. client が指定してよいのは locale だけ
// =========================================================

test('受け付ける body キーは locale だけ', () => {
  assert.deepEqual([...ALLOWED_BODY_KEYS], ['locale']);
});

test('未知のキーがあれば 400 unknown_field（黙って無視しない）', async () => {
  const deps = publishedDeps();
  const { res, body } = await call(deps, req({
    body: JSON.stringify({ locale: 'ja', foo: 'bar' }),
  }));
  assert.equal(res.status, 400);
  assert.deepEqual(body, { error: 'unknown_field' });
  assert.equal(deps.rpc.calls.length, 0);
});

test('client が terms_version を送ったら 400（静かに無視しない）', async () => {
  const deps = publishedDeps();
  const { res, body } = await call(deps, req({
    body: JSON.stringify({ locale: 'ja', terms_version: '2020-01-01' }),
  }));
  assert.equal(res.status, 400);
  assert.deepEqual(body, { error: 'unknown_field' });
  assert.equal(deps.rpc.calls.length, 0, '古い版で記録されない');
});

test('client が user_id / accepted_at / id を送ったら 400', async () => {
  for (const extra of [
    { user_id: '00000000-0000-0000-0000-000000000000' },
    { accepted_at: '2020-01-01T00:00:00.000Z' },
    { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
  ]) {
    const deps = publishedDeps();
    const { res, body } = await call(deps, req({
      body: JSON.stringify({ locale: 'ja', ...extra }),
    }));
    assert.equal(res.status, 400, JSON.stringify(extra));
    assert.deepEqual(body, { error: 'unknown_field' }, JSON.stringify(extra));
    assert.equal(deps.rpc.calls.length, 0, JSON.stringify(extra));
  }
});


// =========================================================
// 5. draft は fail closed / published は成功経路
// =========================================================

test('前提: 本番の Subscription Terms 設定は published', () => {
  assert.equal(SUBSCRIPTION_TERMS_CONFIG.status, 'published');
  assert.match(String(SUBSCRIPTION_TERMS_CONFIG.version), /^\d{4}-\d{2}-\d{2}(?:-\d+)?$/);
});

test('本番 config のまま呼ぶと 200 で、現行版が記録される', () => {
  // **version を注入しない経路**。published 化で 503 が 200 になったことを固定する。
  return (async () => {
    const deps = productionDeps();
    const { res, body } = await call(deps);
    assert.equal(res.status, 200);
    assert.equal(body.accepted, true);
    assert.equal(body.terms_version, SUBSCRIPTION_TERMS_CONFIG.version);
    assert.equal(body.locale, 'ja');
    assert.equal(deps.rpc.calls.length, 1);
    assert.equal(deps.rpc.calls[0].args.p_terms_version, SUBSCRIPTION_TERMS_CONFIG.version);
  })();
});

test('client は版を指定できない（body に版を入れても拒否される）', async () => {
  const deps = productionDeps();
  const { res, body } = await call(deps, req({
    body: JSON.stringify({ locale: 'ja', terms_version: '1999-01-01' }),
  }));
  assert.equal(res.status, 400);
  assert.deepEqual(body, { error: 'unknown_field' });
  assert.equal(deps.rpc.calls.length, 0);
});

test('draft を再現すると 503 terms_not_available', async () => {
  const deps = draftDeps();
  const { res, body } = await call(deps);
  assert.equal(res.status, 503);
  assert.deepEqual(body, { error: 'terms_not_available' });
});

test('draft のあいだ RPC を 1 回も呼ばない（DB に 1 行も書かれない）', async () => {
  const deps = draftDeps();
  await call(deps);
  assert.equal(deps.rpc.calls.length, 0);
});

test('draft でも session までは進む（401 と 503 を取り違えない）', async () => {
  const deps = draftDeps();
  await call(deps);
  assert.equal(deps.session.calls.length, 1);
});

test('503 の応答に config の内部詳細を出さない', async () => {
  const { res, text } = await call(draftDeps());
  assert.equal(res.status, 503);
  for (const leak of ['draft', 'version', 'null', 'not_published',
                      'SUBSCRIPTION_TERMS_CONFIG', 'billing-config']) {
    assert.equal(text.includes(leak), false, '漏れている: ' + leak);
  }
});

test('現行版の取得が SubscriptionTermsConfigError 以外で落ちても 503', async () => {
  const deps = publishedDeps({
    currentVersion: () => { throw new Error('boom'); },
  });
  const { res, body } = await call(deps);
  assert.equal(res.status, 503);
  assert.deepEqual(body, { error: 'terms_not_available' });
  assert.equal(deps.rpc.calls.length, 0);
});

test('現行版が文字列でなければ 503（契約違反を成功にしない）', async () => {
  for (const bad of [null, undefined, '', 0, {}, []]) {
    const deps = publishedDeps({ currentVersion: () => bad });
    const { res, body } = await call(deps);
    assert.equal(res.status, 503, JSON.stringify(bad));
    assert.deepEqual(body, { error: 'terms_not_available' }, JSON.stringify(bad));
    assert.equal(deps.rpc.calls.length, 0, JSON.stringify(bad));
  }
});

test('draft の理由コードはログに出すが応答には出さない', async () => {
  const seen = [];
  const logger = { error() {}, log() {}, warn(...a) { seen.push(a.join(' ')); } };
  const { text } = await call(draftDeps({ logger }));
  assert.ok(seen.some((l) => l.includes('not_published')), 'ログには理由が残る');
  assert.equal(text.includes('not_published'), false, '応答には出さない');
});

test('SubscriptionTermsConfigError は code を持つ（ログの分類に使える）', () => {
  const e = new SubscriptionTermsConfigError('not_published', 'x');
  assert.equal(e.code, 'not_published');
  assert.equal(e.name, 'SubscriptionTermsConfigError');
});


// =========================================================
// 6. published 経路（本番 config は書き換えず注入で再現）
// =========================================================

test('published なら RPC を 1 回だけ、正しい名前で呼ぶ', async () => {
  const deps = publishedDeps();
  const { res } = await call(deps);
  assert.equal(res.status, 200);
  assert.equal(deps.rpc.calls.length, 1);
  assert.equal(deps.rpc.calls[0].name, RPC_NAME);
  assert.equal(deps.rpc.calls[0].options.env, ENV);
});

test('RPC へ渡すのは p_user_id / p_terms_version / p_locale の 3 つだけ', async () => {
  const deps = publishedDeps();
  await call(deps);
  const args = deps.rpc.calls[0].args;
  assert.deepEqual(Object.keys(args).sort(), ['p_locale', 'p_terms_version', 'p_user_id']);
  assert.equal(args.p_user_id, USER_ID);
  assert.equal(args.p_terms_version, PUBLISHED_VERSION);
  assert.equal(args.p_locale, 'ja');
});

test('user_id は session だけを正とする（body で上書きできない）', async () => {
  const deps = publishedDeps();
  // body に user_id を入れると 400 になるので、そもそも到達しないことを確認する
  const rejected = await call(deps, req({
    body: JSON.stringify({ locale: 'ja', user_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }),
  }));
  assert.equal(rejected.res.status, 400);
  assert.equal(deps.rpc.calls.length, 0);

  // 正常系では session の user_id がそのまま渡る
  const ok = publishedDeps();
  await call(ok);
  assert.equal(ok.rpc.calls[0].args.p_user_id, USER_ID);
});

test('版は server が決める（client からも DB からも受け取らない）', async () => {
  const deps = publishedDeps({
    currentVersion: stubVersion('2027-04-01'),
    rpc: stubRpc(null, { terms_version: '2027-04-01' }),
  });
  await call(deps);
  assert.equal(deps.rpc.calls[0].args.p_terms_version, '2027-04-01');
});

test('成功レスポンスは accepted / terms_version / locale / accepted_at だけ', async () => {
  const { res, body } = await call(publishedDeps());
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(body).sort(),
    ['accepted', 'accepted_at', 'locale', 'terms_version']);
  assert.deepEqual(body, {
    accepted: true,
    terms_version: PUBLISHED_VERSION,
    locale: 'ja',
    accepted_at: ACCEPTED_AT,
  });
});

test('成功レスポンスに id / user_id / PII を出さない', async () => {
  const { text } = await call(publishedDeps());
  for (const leak of [USER_ID, 'user_id', '"id"',
                      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                      'email', 'google_sub', 'dummytoken', 'sb_secret',
                      'sk_test', 'cus_', 'sub_']) {
    assert.equal(text.includes(leak), false, '漏れている: ' + leak);
  }
});

test('レスポンスは no-store（同意の記録をキャッシュさせない）', async () => {
  const { res } = await call(publishedDeps());
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Vary'), 'Cookie');
  assert.match(res.headers.get('Content-Type'), /application\/json/);
});

test('同じ同意を繰り返し送っても 200（冪等性は DB 側の責務）', async () => {
  // RPC は ON CONFLICT DO NOTHING + 既存行 SELECT なので、
  // 2 回目も同じ行が返る。HTTP 層で重複判定をしない。
  const deps = publishedDeps();
  const first = await call(deps);
  const second = await call(deps);
  assert.equal(first.res.status, 200);
  assert.equal(second.res.status, 200);
  assert.deepEqual(first.body, second.body);
  assert.equal(deps.rpc.calls.length, 2, 'HTTP 層で握り潰さず毎回 RPC を呼ぶ');
});


// =========================================================
// 7. RPC 失敗 / 契約違反
// =========================================================

test('Supabase 到達不能は 502 database_unavailable', async () => {
  const deps = publishedDeps({
    rpc: stubRpc(new SupabaseError('unavailable', 'unreachable')),
  });
  const { res, body } = await call(deps);
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: 'database_unavailable' });
});

test('Supabase 設定不足は 500 server_misconfigured', async () => {
  const deps = publishedDeps({
    rpc: stubRpc(new SupabaseError('not_configured', 'missing env')),
  });
  const { res, body } = await call(deps);
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'server_misconfigured' });
});

test('RPC が例外を投げたら 500 に丸める', async () => {
  const deps = publishedDeps({ rpc: stubRpc(new Error('boom')) });
  const { res, body } = await call(deps);
  assert.equal(res.status, 500);
  assert.deepEqual(body, { error: 'internal_error' });
});

test('RPC の戻りが 0 行 / 複数行 / 非配列なら 500', async () => {
  // stubRpc の既定行と混同しないよう、返り値をそのまま返すスタブを使う。
  const rawRpc = (value) => {
    const calls = [];
    const fn = async (name, args, options) => { calls.push({ name, args, options }); return value; };
    fn.calls = calls;
    return fn;
  };
  for (const rows of [[], [{}, {}], null, undefined, 'x', {}, 0]) {
    const deps = publishedDeps({ rpc: rawRpc(rows) });
    const { res, body } = await call(deps);
    assert.equal(res.status, 500, JSON.stringify(rows));
    assert.deepEqual(body, { error: 'internal_error' }, JSON.stringify(rows));
  }
});

test('RPC の戻りに必要な列が欠けていたら 500', async () => {
  const base = { terms_version: PUBLISHED_VERSION, locale: 'ja', accepted_at: ACCEPTED_AT };
  for (const key of ['terms_version', 'locale', 'accepted_at']) {
    const row = { ...base };
    delete row[key];
    const deps = publishedDeps({ rpc: stubRpc([row]) });
    const { res } = await call(deps);
    assert.equal(res.status, 500, key + ' 欠落');
  }
});

test('RPC が要求と違う版 / locale を返したら 500（黙って成功にしない）', async () => {
  const wrongVersion = publishedDeps({ rpc: stubRpc(null, { terms_version: '1999-01-01' }) });
  assert.equal((await call(wrongVersion)).res.status, 500);

  const wrongLocale = publishedDeps({ rpc: stubRpc(null, { locale: 'en' }) });
  assert.equal((await call(wrongLocale)).res.status, 500);
});

test('エラー応答にも secret / token / user_id を出さない', async () => {
  const cases = [
    draftDeps(),
    publishedDeps({ rpc: stubRpc(new SupabaseError('unavailable', 'sb_secret_leak')) }),
    publishedDeps({ rpc: stubRpc([]) }),
  ];
  for (const deps of cases) {
    const { text } = await call(deps);
    for (const leak of [USER_ID, 'sb_secret', 'dummytoken', 'example-project']) {
      assert.equal(text.includes(leak), false, leak);
    }
  }
});


// =========================================================
// 8. 既存の認証 / session 挙動への回帰が無いこと
// =========================================================

test('session のデータ異常は 500、設定エラーは 500、到達不能は 502', async () => {
  const cases = [
    [SESSION_RESULT.DATA_ERROR, 500, 'internal_error'],
    [SESSION_RESULT.MISCONFIGURED, 500, 'server_misconfigured'],
    [SESSION_RESULT.UNAVAILABLE, 502, 'database_unavailable'],
  ];
  for (const [status, expected, code] of cases) {
    const deps = draftDeps({ session: stubSession({ status, reason: 'x' }) });
    const { res, body } = await call(deps);
    assert.equal(res.status, expected, status);
    assert.deepEqual(body, { error: code }, status);
    assert.equal(deps.rpc.calls.length, 0, status);
  }
});

test('401 のとき session Cookie を消す（既存 API と同じ挙動）', async () => {
  const deps = draftDeps({
    session: stubSession({ status: SESSION_RESULT.UNAUTHENTICATED }),
  });
  const { res } = await call(deps);
  assert.equal(res.status, 401);
  assert.match(res.headers.get('Set-Cookie') ?? '', new RegExp(SESSION_COOKIE_NAME));
});

test('handleTermsConsent は Cookie session と Origin を両方要求する', async () => {
  // webhook（署名のみ）とは違い、こちらはブラウザからの POST。
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../terms/consent.js', import.meta.url), 'utf8'));
  assert.match(src, /preflight/, 'preflight を使う');
  assert.equal(src.includes('stripe'), false, 'Stripe とは無関係');
});
