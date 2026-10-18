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
//
//   2026-10-18 改定で足したもの（4 節で固定）:
//     - メールアドレスを条件付きで保存し得ること / サーバーに保存する情報
//     - アクセストークンをログイン時の本人確認に限りサーバーへ送ること
//     - 紹介ページの背景動画（自サイト配信。外部の動画配信へ通信しない）と、
//       本サービス自身の Cookie / Google のログインの仕組みの区別
//     - アカウント削除後に保持する記録（承認済みの文言）
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

test('最終更新日が 2026-10-18 改定後の日付になっている', () => {
  assert.match(privacy, /最終更新日：2026年10月18日/);
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

// =========================================================
// 4. 2026-10-18 改定（実装との照合結果）
//
//   認証処理は users.email へ「Google から提供されたときだけ」保存する
//   （verifyGoogleAccessToken / verifyGoogleIdToken → p_email）。
//   アクセストークンはログイン時に /api/auth/google-session へ送られる。
//   背景動画は自サイトの MP4（/about/assets/hero-bg.mp4）を video 要素で自動再生し、
//   YouTube は読み込まない（使い方動画のセクションは非表示）。
//   これらと食い違う旧表現を戻さないことを固定する。
// =========================================================

test('「メールアドレスは取得しない」と断定する旧表現が残っていない', () => {
  assert.equal(privacy.includes('メールアドレスやその他の個人情報は取得しません'), false);
});

test('メールアドレスを条件付きで保存し得ることを書いている', () => {
  assert.match(privacy, /メールアドレスの提供を要求していませんが、認証時にGoogleから提供された場合は/);
});

test('アクセストークンをログイン時の本人確認に限りサーバーへ送ると書いている', () => {
  assert.match(privacy, /ログイン時に限り、本人確認のためアクセストークンを本サービスのサーバーへ送信します/);
  assert.equal(privacy.includes('これらの情報はサーバーへ送信されることはありません'), false,
    'アクセストークンもサーバーへ送らないと読める旧表現が残っている');
});

test('サーバーに保存する情報の節がある', () => {
  assert.match(privacy, /<h2>サーバーに保存する情報<\/h2>/);
  assert.match(privacy, /有料プラン利用規約への同意記録/);
});

test('背景動画は自サイト配信で、外部の動画配信へ通信しないと書いている', () => {
  assert.match(privacy, /<h2>紹介ページの背景動画<\/h2>/);
  assert.match(privacy, /本サービスのサーバーから動画ファイルを配信して再生しています/);
  assert.match(privacy, /操作をする前に背景動画を読み込み、無音で自動再生します/);
  assert.match(privacy, /YouTubeなど外部の動画配信サービスへの通信は行いません/);
  // 背景動画を YouTube 埋め込みとして説明する旧表現を戻さない
  assert.equal(privacy.includes('YouTube API サービス'), false);
  assert.equal(privacy.includes('動画の埋め込み（YouTube）'), false);
});

test('ポリシーの説明と LP の実装が一致している（背景動画は自サイトの MP4、YouTube を読み込まない）', () => {
  const about = fs.readFileSync(new URL('../../public/about/index.html', import.meta.url), 'utf8');
  assert.match(about, /var VIDEO_SRC = '\/about\/assets\/hero-bg\.mp4';/);
  assert.ok(fs.existsSync(new URL('../../public/about/assets/hero-bg.mp4', import.meta.url)), '背景動画のファイルが無い');
  assert.equal(about.includes('iframe_api'), false, 'YouTube IFrame API を読み込んでいる');
  assert.equal(about.includes('YT.Player'), false, 'YouTube プレーヤーを作っている');
  // 使い方動画（クリックで YouTube を読み込む）は非表示のまま。再表示するならポリシーに YouTube の説明を戻す
  assert.match(about, /<div class="video" id="videoSection" hidden>/);
});

test('本サービス自身の Cookie と Google のログインの仕組みを区別している', () => {
  assert.match(privacy, /本サービス自身が設定するCookie/);
  assert.match(privacy, /Googleが提供するログインの仕組み/);
  const link = privacy.match(/<a href="https:\/\/www\.google\.com\/policies\/privacy"[^>]*>/);
  assert.ok(link, 'Google プライバシーポリシーへのリンクが無い');
  assert.match(link[0], /target="_blank"/);
  assert.match(link[0], /rel="noopener noreferrer"/);
});

test('アカウント削除後に保持する記録を承認済みの文言で書いている', () => {
  assert.match(privacy, /<h2>アカウント削除後に保持する情報<\/h2>/);
  assert.ok(privacy.includes('アカウント削除後も、契約に関する確認・紛争対応のための規約同意記録、および決済通知の重複処理防止・障害調査のための処理履歴を保持します。'));
  assert.match(privacy, /削除したアカウントの内部の利用者ID/);
});

test('保持期間を「未定」と書いていない', () => {
  assert.equal(privacy.includes('未定'), false);
});

test('terms.html 側に Stripe の記述を足していない（変更していない）', () => {
  assert.equal(terms.includes('決済について（Stripe）'), false);
  assert.equal(terms.includes('stripe.com/jp/privacy'), false);
});
