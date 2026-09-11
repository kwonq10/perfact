// =========================================================
// Checkout の戻り先ページの静的テスト
//
//   対象:
//     public/billing/success.html -> /billing/success
//     public/billing/cancel.html  -> /billing/cancel
//
//   このテストが守るもの:
//     - **success ページが entitlement を確定させないこと。**
//       Pro の正は webhook -> DB。ここに来ただけで「Pro になった」と書かない
//     - **query parameter を信用しないこと。**
//       JS が無いので session_id / plan / paid / user_id を読む経路が存在しない
//     - Stripe の内部 ID / PII / secret を 1 つも表示しないこと
//     - JS / 外部リソースを持ち込んでいないこと
//     - **checkout API が向けている URL と実ファイルが一致すること**
//       （checkout.js の SUCCESS_PATH / CANCEL_PATH を正とする）
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  CANCEL_PATH,
  SUCCESS_PATH,
  buildCheckoutParams,
} from '../../functions/api/billing/checkout.js';

const SUCCESS_URL = new URL('../../public/billing/success.html', import.meta.url);
const CANCEL_URL = new URL('../../public/billing/cancel.html', import.meta.url);

const success = fs.readFileSync(SUCCESS_URL, 'utf8');
const cancel = fs.readFileSync(CANCEL_URL, 'utf8');

const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
const visibleText = (html) => {
  const body = stripComments(html).split('<body>')[1] || '';
  return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

const successNoComments = stripComments(success);
const cancelNoComments = stripComments(cancel);
const successVisible = visibleText(success);
const cancelVisible = visibleText(cancel);

/** 両ページを同じ観点で回すための組。 */
const PAGES = [
  { name: 'success', html: success, noComments: successNoComments, visible: successVisible },
  { name: 'cancel', html: cancel, noComments: cancelNoComments, visible: cancelVisible },
];


// --- 1. ページが存在し、URL が checkout API と一致する ---

test('checkout API の戻り先 URL に対応するファイルが実在する', () => {
  // checkout.js の定数が正。ページ側を後から動かしたらここで落ちる。
  assert.equal(SUCCESS_PATH, '/billing/success');
  assert.equal(CANCEL_PATH, '/billing/cancel');
  assert.ok(fs.existsSync(SUCCESS_URL), 'public/billing/success.html が無い');
  assert.ok(fs.existsSync(CANCEL_URL), 'public/billing/cancel.html が無い');
});

test('Checkout に渡す success_url / cancel_url が新しいページを指している', () => {
  const origin = 'https://sukimacalendar.com';
  const params = buildCheckoutParams({
    userId: '11111111-2222-3333-4444-555555555555',
    priceId: 'price_dummy',
    planId: 'web_pro',
    phase: 'launch',
    termsVersion: '2026-09-09',
    locale: 'ja',
    origin,
    customerId: null,
    confirmedAt: '2026-09-09T00:00:00.000Z',
  });
  // success_url には Stripe が置換するテンプレートが付く。
  assert.ok(params.success_url.startsWith(origin + SUCCESS_PATH), params.success_url);
  assert.equal(params.cancel_url, origin + CANCEL_PATH);
  // **client から URL を差し替えられないこと**は billing-checkout.test.mjs 側で固定済み。
  assert.ok(params.success_url.startsWith(origin), '戻り先は同一 origin');
  assert.ok(params.cancel_url.startsWith(origin), '戻り先は同一 origin');
});

test('lang は ja で、h1 が 1 つある', () => {
  for (const page of PAGES) {
    assert.match(page.html, /<html lang="ja">/, page.name);
    const h1s = page.html.match(/<h1>[\s\S]*?<\/h1>/g) || [];
    assert.equal(h1s.length, 1, page.name + ': h1 は 1 つ');
  }
});

test('title があり、決済の戻り先だと分かる', () => {
  const s = success.match(/<title>([^<]*)<\/title>/);
  const c = cancel.match(/<title>([^<]*)<\/title>/);
  assert.ok(s && c);
  assert.match(s[1], /お支払い/);
  assert.match(c[1], /完了していません/);
});

test('決済の戻り先なので検索索引に載せない', () => {
  for (const page of PAGES) {
    assert.match(page.html, /<meta name="robots" content="noindex">/, page.name);
  }
});


// --- 2. JS / 外部リソース / query parameter ---

test('JavaScript を持たない（query parameter を読む経路が無い）', () => {
  for (const page of PAGES) {
    assert.equal(page.html.includes('<script'), false, page.name);
    assert.equal(/\son(click|load|error|change|submit|input)=/i.test(page.html), false, page.name);
    assert.equal(page.html.includes('javascript:'), false, page.name);
  }
});

test('query parameter を読むコードが 1 つも無い', () => {
  for (const page of PAGES) {
    for (const api of ['location.search', 'URLSearchParams', 'window.location',
                       'document.URL', 'innerHTML', 'document.write']) {
      assert.equal(page.html.includes(api), false, page.name + ': ' + api);
    }
  }
});

test('query parameter 名を表示や判定に使っていない', () => {
  // ?session_id=... や ?paid=1 を根拠に「購入できた」と見せない。
  for (const page of PAGES) {
    for (const key of ['session_id', 'customer_id', 'user_id', 'price', 'paid',
                       'plan_id', 'subscription_id']) {
      assert.equal(page.visible.includes(key), false, page.name + ': ' + key);
    }
  }
});

test('外部リソースを読み込まない（自己完結した静的ページ）', () => {
  for (const page of PAGES) {
    assert.equal(/<link[^>]+rel="stylesheet"/i.test(page.noComments), false, page.name);
    assert.equal(/<(script|iframe|source|video|audio|object|embed)\b/i.test(page.noComments),
      false, page.name);
    assert.equal(/@import|url\(\s*https?:/i.test(page.noComments), false, page.name);
    assert.equal(page.noComments.includes('https://'), false, page.name + ': 外部 URL');
    // 画像は同一オリジンのアプリアイコンだけ
    const imgs = page.noComments.match(/<img[^>]*>/g) || [];
    assert.equal(imgs.length, 1, page.name);
    assert.match(imgs[0], /src="\/icon-192\.png"/, page.name);
  }
});

test('フォームや入力欄を持たない（掲示専用）', () => {
  for (const page of PAGES) {
    for (const tag of ['<input', '<button', '<form', '<select', '<textarea']) {
      assert.equal(page.noComments.includes(tag), false, page.name + ': ' + tag);
    }
  }
});


// --- 3. success — 支払いを「受け付けた」までしか言わない ---

test('success: 支払いを受け付けた趣旨が書いてある', () => {
  assert.match(successVisible, /お支払い手続きを受け付けました/);
  assert.match(successVisible, /ありがとうございます/);
});

test('success: 確認中であることと、反映に時間がかかり得ることを書く', () => {
  assert.match(successVisible, /確認しています/);
  assert.match(successVisible, /確認ができ次第/);
  assert.match(successVisible, /お時間がかかる場合があります/);
});

test('success: この画面が確認済みの証明ではないと明示する', () => {
  assert.match(successVisible, /この画面は、お支払いの確認が済んだことを示すものではありません/);
});

test('success: Pro が有効になったと断定しない（entitlement を確定させない）', () => {
  const forbidden = [
    'アップグレードが完了',
    'Pro が有効になりました',
    'Proが有効になりました',
    '有効になりました',
    'ご利用いただけるようになりました。',
    'Web Pro になりました',
    'アップグレードしました',
    '完了しました',
    'is now active',
    'has been activated',
    'upgrade complete',
    'Upgrade complete',
    'You are now',
  ];
  for (const phrase of forbidden) {
    assert.equal(successVisible.includes(phrase), false, '断定表現がある: ' + phrase);
  }
});

test('success: 「確認できたら使える」という条件付きの書き方になっている', () => {
  // 条件節（確認ができ次第 / once ...）を伴わずに利用可能と書いていないこと。
  assert.match(successVisible, /確認ができ次第、Web Pro の機能をお使いいただけるようになります/);
  assert.match(successVisible, /once that confirmation finishes/);
});

test('success: スキマへ戻る CTA がある', () => {
  assert.match(successNoComments, /<a href="\/" class="btn">スキマに戻る<\/a>/);
});

test('success: 契約条件の確認先として規約へリンクする', () => {
  assert.match(successNoComments, /href="\/terms\/subscription"/);
});


// --- 4. cancel — 何も起きていないことを伝える ---

test('cancel: 購入が完了していないと書いてある', () => {
  assert.match(cancelVisible, /購入手続きは完了していません/);
});

test('cancel: Web Pro への変更が無いと書いてある', () => {
  assert.match(cancelVisible, /Web Pro への変更は行われていません/);
});

test('cancel: この画面を理由に請求されないと書いてある', () => {
  assert.match(cancelVisible, /料金を請求することはありません/);
});

test('cancel: 無料プランで使い続けられると書いてある', () => {
  assert.match(cancelVisible, /引き続き無料プランでご利用いただけます/);
});

test('cancel: スキマへ戻る CTA がある', () => {
  assert.match(cancelNoComments, /<a href="\/" class="btn">スキマに戻る<\/a>/);
});

test('cancel: 存在しない Pricing ページへ誘導しない', () => {
  for (const page of PAGES) {
    for (const path of ['/pricing', '/checkout', '/billing/portal', '/plans']) {
      assert.equal(page.noComments.includes('href="' + path), false, page.name + ': ' + path);
    }
  }
});


// --- 5. PII / Stripe の内部情報を出さない ---

test('Stripe の内部 ID や secret を表示しない', () => {
  for (const page of PAGES) {
    for (const prefix of ['cus_', 'sub_', 'cs_', 'price_', 'sk_', 'pk_', 'whsec_',
                          'checkout.stripe.com']) {
      assert.equal(page.html.includes(prefix), false, page.name + ': ' + prefix);
    }
  }
});

test('金額・メールアドレス・利用者名を表示しない', () => {
  for (const page of PAGES) {
    assert.equal(/@[a-z0-9.-]+\.[a-z]{2,}/i.test(page.visible), false, page.name + ': メール');
    assert.equal(/\d+\s*円/.test(page.visible), false, page.name + ': 金額');
    assert.equal(/\$\s*\d/.test(page.visible), false, page.name + ': 金額');
  }
});


// --- 6. アクセシビリティ / 表示 ---

test('本文だけで状況が分かる（画像やスピナーに依存しない）', () => {
  for (const page of PAGES) {
    // 装飾画像は alt="" で読み上げから外し、意味は文章側に持たせる
    assert.match(page.noComments, /<img[^>]+alt=""/, page.name);
    assert.equal(/spinner|loading|読み込み中/i.test(page.visible), false, page.name);
    assert.ok(page.visible.length > 80, page.name + ': 説明が短すぎる');
  }
});

test('main ランドマークがあり、キーボードで押せるリンクになっている', () => {
  for (const page of PAGES) {
    assert.match(page.noComments, /<main class="card">/, page.name);
    // CTA は a 要素。div + onclick のような擬似ボタンにしない
    assert.match(page.noComments, /<a href="\/" class="btn">/, page.name);
    assert.match(page.html, /\.btn:focus-visible/, page.name + ': フォーカス表示');
  }
});

test('mobile 幅の指定と viewport がある', () => {
  for (const page of PAGES) {
    assert.match(page.html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/,
      page.name);
    assert.match(page.html, /@media \(max-width: 380px\)/, page.name);
  }
});

test('英語の補足は 1 段落だけで、i18n 基盤を持ち込んでいない', () => {
  for (const page of PAGES) {
    const en = page.noComments.match(/lang="en"/g) || [];
    assert.equal(en.length, 1, page.name);
    // 言語切替の UI やスクリプトは足していない
    assert.equal(page.html.includes('langToggle'), false, page.name);
    assert.equal(page.html.includes('hreflang'), false, page.name);
  }
});


// --- 7. 既存ページを巻き込んでいない ---

test('2 ページは別ファイル・別内容', () => {
  assert.notEqual(success, cancel);
  assert.equal(successVisible.includes('購入手続きは完了していません'), false);
  assert.equal(cancelVisible.includes('お支払い手続きを受け付けました'), false);
});

test('既存の一般利用規約を巻き込んでいない', () => {
  const general = fs.readFileSync(new URL('../../public/terms.html', import.meta.url), 'utf8');
  assert.match(general, /<title>利用規約 - スキマ<\/title>/);
  assert.equal(general.includes('/billing/success'), false);
  assert.equal(general.includes('/billing/cancel'), false);
});
