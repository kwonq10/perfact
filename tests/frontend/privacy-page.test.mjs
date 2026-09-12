// =========================================================
// public/privacy.html の単体テスト
//
//   このページは **Google OAuth の審査を通った文面**なので、
//   既存の記述を崩していないことを回帰として固定する。
//   今回足したのは「決済について（Stripe）」の 1 セクションだけ。
//
//   ここで固定するもの:
//     - Stripe を決済に使うこと / 決済情報が Stripe へ渡ること
//     - **カード番号とセキュリティコードを本サービスが保持しないこと**
//     - 利用目的（請求・支払い確認・契約管理・不正防止・法令上の記録）
//     - Stripe のプライバシーポリシーへの案内（外部リンクの安全属性つき）
//     - **既存の Google ユーザーデータの記述を 1 つも消していないこと**
//     - Subscription Terms の中身をここへ持ち込んでいないこと
//     - public/terms.html を巻き込んで変更していないこと
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const privacy = fs.readFileSync(new URL('../../public/privacy.html', import.meta.url), 'utf8');
const terms = fs.readFileSync(new URL('../../public/terms.html', import.meta.url), 'utf8');


// =========================================================
// 1. 追加した Stripe セクション
// =========================================================

test('決済セクションがあり、Stripe を使うと書いてある', () => {
  assert.match(privacy, /<h2>決済について（Stripe）<\/h2>/);
  assert.match(privacy, /Stripe, Inc\./);
  assert.match(privacy, /有料プランの決済/);
});

test('決済情報が Stripe へ直接渡ると書いてある', () => {
  assert.match(privacy, /Stripeが提供する決済ページ/);
  assert.match(privacy, /ユーザーからStripeへ直接提供されます/);
});

test('カード番号とセキュリティコードを保持しないと明記している', () => {
  assert.match(privacy, /クレジットカード番号やセキュリティコードを受け取らず、保持しません/);
});

test('保存するのは識別子と契約状況だけだと書いてある', () => {
  assert.match(privacy, /Stripeの顧客IDおよびサブスクリプションID/);
  assert.match(privacy, /プランおよび契約の状況のみ/);
});

test('利用目的が書いてある（請求・支払い・契約管理・不正防止・法令）', () => {
  for (const purpose of ['料金の請求', '支払いの確認', '契約状態の管理', '不正利用の防止', '法令に基づく記録の保持']) {
    assert.ok(privacy.includes(purpose), '目的が欠けている: ' + purpose);
  }
});

test('Stripe のプライバシーポリシーへ安全な属性で案内している', () => {
  assert.match(privacy, /href="https:\/\/stripe\.com\/jp\/privacy"/);
  const link = privacy.match(/<a href="https:\/\/stripe\.com\/jp\/privacy"[^>]*>/);
  assert.ok(link, 'Stripe へのリンクが無い');
  assert.match(link[0], /target="_blank"/);
  assert.match(link[0], /rel="noopener noreferrer"/);
});

test('決済セクションは 1 つだけ（重複して足していない）', () => {
  const hits = privacy.match(/<h2>決済について（Stripe）<\/h2>/g) ?? [];
  assert.equal(hits.length, 1);
});


// =========================================================
// 2. 既存文面の回帰（審査済みの記述を壊していない）
// =========================================================

test('既存セクションの見出しがすべて残っている', () => {
  for (const h of [
    'はじめに',
    '取得するGoogleユーザーデータ',
    '情報の使用目的',
    '情報の保存・共有について',
    'Googleユーザーデータおよび機密情報の保護措置',
    'ブラウザへの保存情報（localStorage）',
    'Googleアカウントの権限について',
    'アクセス権限の取り消し',
    'Cookieについて',
    'お問い合わせ',
  ]) {
    assert.ok(privacy.includes('<h2>' + h + '</h2>'), '見出しが消えている: ' + h);
  }
});

test('Limited Use の宣言と読み取り専用スコープの記述が残っている', () => {
  assert.match(privacy, /Limited Use requirements/);
  assert.match(privacy, /calendar\.events\.readonly/);
  assert.match(privacy, /calendar\.calendarlist\.readonly/);
  assert.match(privacy, /カレンダーへの書き込み・編集・削除は一切行いません/);
});

test('第三者提供・広告・AI 学習をしない宣言が残っている', () => {
  assert.match(privacy, /第三者に販売・提供・共有することは一切ありません/);
  assert.match(privacy, /広告配信に使用することは一切ありません/);
  assert.match(privacy, /AIモデルの学習に使用することは一切ありません/);
});

test('カレンダーデータをサーバーに保存しない宣言を弱めていない', () => {
  assert.match(privacy, /取得したカレンダーデータをサーバーに保存しません/);
});

test('権限の取り消し案内が残っている', () => {
  assert.match(privacy, /https:\/\/myaccount\.google\.com\/permissions/);
});

test('日本語のみのページで、英語版を作っていない', () => {
  assert.match(privacy, /<html lang="ja">/);
  assert.equal(fs.existsSync(new URL('../../public/privacy/en.html', import.meta.url)), false);
});

test('最終更新日が Stripe 追記後の日付になっている', () => {
  assert.match(privacy, /最終更新日：2026年9月12日/);
});


// =========================================================
// 2-b. Cookie / ローカルストレージの説明が実装と一致している
//
//   ログイン状態は **Cookie**（`__Host-` 付きのセッション Cookie）で維持している。
//   「localStorage だけでログインを維持している」と読める旧表現は
//   実装と食い違うので、残っていないことを固定する。
//   Cookie 名そのものはページに書かない（書く必要がなく、書けば実装に縛られる）。
// =========================================================

test('ログイン状態の維持に Cookie を使うと書いてある', () => {
  assert.match(privacy, /ログイン状態の維持のためにCookieを使用します/);
});

test('分析・広告目的の Cookie を使わない宣言は残っている', () => {
  assert.match(privacy, /分析・広告目的のCookieを使用しません/);
});

test('ローカルストレージの用途が書いてある（localStorage / IndexedDB）', () => {
  assert.match(privacy, /表示設定や背景画像など一部の機能/);
  assert.match(privacy, /localStorage・IndexedDB/);
});

test('「localStorage だけでログインを維持している」と読める旧表現が残っていない', () => {
  assert.equal(privacy.includes('ログイン状態の維持のみにブラウザのlocalStorageを使用します'), false,
    '実装と食い違う旧表現が残っている');
  assert.equal(/ログイン状態の維持のみ/.test(privacy), false);
});

test('Cookie 名そのものはページに書かない', () => {
  assert.equal(privacy.includes('__Host-'), false);
  assert.equal(privacy.includes('sukima_session'), false);
});


// =========================================================
// 3. 混ぜない（Subscription Terms / terms.html）
// =========================================================

test('Subscription Terms の中身を privacy へ持ち込んでいない', () => {
  for (const word of ['第1条', '準拠法', '管轄', 'クーリングオフ', '返金', '解約', '特定商取引']) {
    assert.equal(privacy.includes(word), false, 'privacy に混ぜている: ' + word);
  }
});

test('privacy から購入導線や同意 UI を作っていない', () => {
  assert.equal(/<form[\s>]/.test(privacy), false, 'フォームを置かない');
  assert.equal(/<input[\s>]/.test(privacy), false, '入力欄を置かない');
  assert.equal(privacy.includes('/api/billing/'), false, '課金 API を呼ばない');
  assert.equal(privacy.includes('checkout'), false, 'Checkout 導線を置かない');
});

test('privacy のスクリプトは既存の共有 QR だけ', () => {
  const scripts = privacy.match(/<script[^>]*>/g) ?? [];
  assert.equal(scripts.length, 1, 'スクリプトを増やしていない');
  assert.match(scripts[0], /\/assets\/share-qr\.js/);
});

test('terms.html 側に Stripe の記述を足していない（変更していない）', () => {
  assert.equal(terms.includes('決済について（Stripe）'), false);
  assert.equal(terms.includes('stripe.com/jp/privacy'), false);
});
