// =========================================================
// Stripe webhook 署名検証の単体テスト
//
//   - Stripe へは一度も通信しない。署名は Web Crypto でローカルに作る。
//   - 本番の secret はフィクスチャに保存しない（whsec_dummy_… のみ）。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STRIPE_SIGNATURE_TOLERANCE_SEC,
  StripeSignatureError,
  computeStripeSignature,
  parseStripeSignatureHeader,
  timingSafeEqualHex,
  verifyStripeWebhookSignature,
} from '../_lib/stripe-webhook.js';

// --- テスト用のダミー secret（本番値ではない） ---
const SECRET = 'whsec_dummy_for_tests_only';
const BODY = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });
const NOW_SEC = 1788000000;
const NOW_MS = NOW_SEC * 1000;

const isSigError = (reason) => (e) =>
  e instanceof StripeSignatureError && e.reason === reason;

/** 正しい署名ヘッダを組み立てる。 */
async function signHeader(body = BODY, t = NOW_SEC, secret = SECRET) {
  const v1 = await computeStripeSignature(secret, t, body);
  return `t=${t},v1=${v1}`;
}

const verify = (o) =>
  verifyStripeWebhookSignature({ rawBody: BODY, secret: SECRET, now: NOW_MS, ...o });


// =========================================================
// 1. ヘッダの解析
// =========================================================

test('t と v1 を取り出す', () => {
  const r = parseStripeSignatureHeader('t=1788000000,v1=abc123');
  assert.equal(r.timestamp, 1788000000);
  assert.deepEqual(r.signatures, ['abc123']);
});

test('v1 が複数あればすべて拾う', () => {
  const r = parseStripeSignatureHeader('t=1,v1=aa,v1=bb,v1=cc');
  assert.deepEqual(r.signatures, ['aa', 'bb', 'cc']);
});

test('v0 など未知のスキームは無視する（エラーにしない）', () => {
  const r = parseStripeSignatureHeader('t=1,v0=zz,v1=aa');
  assert.deepEqual(r.signatures, ['aa']);
});

test('空白まじり・順序違いでも解析できる', () => {
  const r = parseStripeSignatureHeader(' v1=aa , t=42 ');
  assert.equal(r.timestamp, 42);
  assert.deepEqual(r.signatures, ['aa']);
});

test('v1 は小文字 hex に正規化される', () => {
  assert.deepEqual(parseStripeSignatureHeader('t=1,v1=ABCDEF').signatures, ['abcdef']);
});

test('hex でない v1 は捨てる', () => {
  assert.throws(() => parseStripeSignatureHeader('t=1,v1=zzz'),
    isSigError('missing_signature'));
});

test('ヘッダが無い / 空 / 非文字列は missing_header', () => {
  for (const h of [undefined, null, '', '   ', 123, {}]) {
    assert.throws(() => parseStripeSignatureHeader(h), isSigError('missing_header'), String(h));
  }
});

test('t が無い / 数値でない は missing_timestamp', () => {
  for (const h of ['v1=aa', 't=,v1=aa', 't=abc,v1=aa', 't=1.5,v1=aa', 't=-1,v1=aa']) {
    assert.throws(() => parseStripeSignatureHeader(h), isSigError('missing_timestamp'), h);
  }
});

test('v1 が無ければ missing_signature', () => {
  for (const h of ['t=1', 't=1,v0=aa', 't=1,v1=']) {
    assert.throws(() => parseStripeSignatureHeader(h), isSigError('missing_signature'), h);
  }
});

test('壊れた要素が混ざっていても他を拾う', () => {
  const r = parseStripeSignatureHeader('t=1,,=x,v1,v1=aa');
  assert.equal(r.timestamp, 1);
  assert.deepEqual(r.signatures, ['aa']);
});


// =========================================================
// 2. 定数時間比較
// =========================================================

test('timingSafeEqualHex は同値のみ true', () => {
  assert.equal(timingSafeEqualHex('abc', 'abc'), true);
  assert.equal(timingSafeEqualHex('abc', 'abd'), false);
  assert.equal(timingSafeEqualHex('abc', 'ab'), false, '長さ違い');
  assert.equal(timingSafeEqualHex('', ''), true);
  for (const bad of [null, undefined, 1, {}, ['a']]) {
    assert.equal(timingSafeEqualHex('abc', bad), false, String(bad));
    assert.equal(timingSafeEqualHex(bad, 'abc'), false, String(bad));
  }
});


// =========================================================
// 3. 検証本体
// =========================================================

test('正しい署名は通る', async () => {
  const header = await signHeader();
  const r = await verify({ header });
  assert.equal(r.timestamp, NOW_SEC);
});

test('署名が違えば signature_mismatch', async () => {
  const header = `t=${NOW_SEC},v1=${'0'.repeat(64)}`;
  await assert.rejects(() => verify({ header }), isSigError('signature_mismatch'));
});

test('secret が違えば通らない', async () => {
  const header = await signHeader(BODY, NOW_SEC, 'whsec_other_dummy');
  await assert.rejects(() => verify({ header }), isSigError('signature_mismatch'));
});

test('rawBody が 1 文字でも変われば通らない', async () => {
  const header = await signHeader();
  await assert.rejects(() => verify({ header, rawBody: BODY + ' ' }),
    isSigError('signature_mismatch'));
  await assert.rejects(
    () => verify({ header, rawBody: JSON.stringify(JSON.parse(BODY), null, 2) }),
    isSigError('signature_mismatch'));
});

test('複数 v1 のうち 1 つが正しければ通る', async () => {
  const good = await computeStripeSignature(SECRET, NOW_SEC, BODY);
  for (const header of [
    `t=${NOW_SEC},v1=${'0'.repeat(64)},v1=${good}`,
    `t=${NOW_SEC},v1=${good},v1=${'0'.repeat(64)}`,
  ]) {
    const r = await verify({ header });
    assert.equal(r.timestamp, NOW_SEC);
  }
});

test('複数 v1 がすべて不正なら落ちる', async () => {
  const header = `t=${NOW_SEC},v1=${'0'.repeat(64)},v1=${'1'.repeat(64)}`;
  await assert.rejects(() => verify({ header }), isSigError('signature_mismatch'));
});

test('古すぎる timestamp は拒否（tolerance は 300 秒）', async () => {
  assert.equal(STRIPE_SIGNATURE_TOLERANCE_SEC, 300);
  await verify({ header: await signHeader(BODY, NOW_SEC - STRIPE_SIGNATURE_TOLERANCE_SEC) });
  const tooOld = await signHeader(BODY, NOW_SEC - STRIPE_SIGNATURE_TOLERANCE_SEC - 1);
  await assert.rejects(() => verify({ header: tooOld }),
    isSigError('timestamp_out_of_tolerance'));
});

test('未来すぎる timestamp も拒否', async () => {
  await verify({ header: await signHeader(BODY, NOW_SEC + STRIPE_SIGNATURE_TOLERANCE_SEC) });
  const tooNew = await signHeader(BODY, NOW_SEC + STRIPE_SIGNATURE_TOLERANCE_SEC + 1);
  await assert.rejects(() => verify({ header: tooNew }),
    isSigError('timestamp_out_of_tolerance'));
});

test('tolerance は上書きできる', async () => {
  const header = await signHeader(BODY, NOW_SEC - 1000);
  await assert.rejects(() => verify({ header }), isSigError('timestamp_out_of_tolerance'));
  await verify({ header, toleranceSec: 2000 });
});

test('timestamp を書き換えると署名も合わなくなる', async () => {
  const v1 = await computeStripeSignature(SECRET, NOW_SEC, BODY);
  await assert.rejects(() => verify({ header: `t=${NOW_SEC + 1},v1=${v1}` }),
    isSigError('signature_mismatch'));
});

test('secret 未設定は not_configured', async () => {
  const header = await signHeader();
  for (const secret of [undefined, null, '', 123]) {
    await assert.rejects(() => verify({ header, secret }), isSigError('not_configured'));
  }
});

test('rawBody が文字列でなければ invalid_body', async () => {
  const header = await signHeader();
  for (const rawBody of [undefined, null, 12, {}]) {
    await assert.rejects(() => verify({ header, rawBody }), isSigError('invalid_body'));
  }
});

test('now が不正なら invalid_now', async () => {
  const header = await signHeader();
  for (const now of [NaN, 'x', {}]) {
    await assert.rejects(() => verify({ header, now }), isSigError('invalid_now'));
  }
});

test('now を省略するとサーバー現在時刻で判定する', async () => {
  const t = Math.floor(Date.now() / 1000);
  const header = await signHeader(BODY, t);
  const r = await verifyStripeWebhookSignature({ rawBody: BODY, header, secret: SECRET });
  assert.equal(r.timestamp, t);
});

test('エラーに secret も rawBody も載せない', async () => {
  try {
    await verify({ header: `t=${NOW_SEC},v1=${'0'.repeat(64)}` });
    assert.fail('通ってはいけない');
  } catch (e) {
    const dump = JSON.stringify({ ...e, message: e.message });
    assert.equal(dump.includes(SECRET), false);
    assert.equal(dump.includes('whsec_'), false);
    assert.equal(dump.includes(BODY), false);
    assert.equal(dump.includes('evt_1'), false);
  }
});

test('computeStripeSignature は 64 文字の小文字 hex を返す（決定的）', async () => {
  const sig = await computeStripeSignature(SECRET, NOW_SEC, BODY);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(sig, await computeStripeSignature(SECRET, NOW_SEC, BODY));
  assert.notEqual(sig, await computeStripeSignature(SECRET, NOW_SEC + 1, BODY));
  assert.notEqual(sig, await computeStripeSignature(SECRET, NOW_SEC, BODY + 'x'));
});
