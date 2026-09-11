// =========================================================
// 特定商取引法に基づく表記ページの静的テスト
//
//   対象: public/legal/commercial-transactions.html  ->  /legal/commercial-transactions
//
//   このテストが守るもの:
//     - **Subscription Terms と数値・条件が食い違わないこと**
//       （片方だけ直したら落ちる）
//     - **法定表示に必要な事業者情報が実際に載っていること**（5A-5-3C で確定）
//     - **確定していない情報を推測で足していないこと**
//       （インボイス登録番号は無い。架空の番号を書かない）
//     - 利用者向けに「未定」「TODO」等を表示していないこと
//     - JS / 外部リソースを持ち込んでいないこと
//     - 既存ページ（特に OAuth 審査済みの一般利用規約）を巻き込んでいないこと
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  PURCHASABLE_COUNTRIES,
  SUBSCRIPTION_TERMS_CONFIG,
} from '../../functions/api/_lib/billing-config.js';

const CT_URL = new URL('../../public/legal/commercial-transactions.html', import.meta.url);
const SUB_URL = new URL('../../public/terms/subscription.html', import.meta.url);
const GENERAL_URL = new URL('../../public/terms.html', import.meta.url);

const ct = fs.readFileSync(CT_URL, 'utf8');
const sub = fs.readFileSync(SUB_URL, 'utf8');
const general = fs.readFileSync(GENERAL_URL, 'utf8');

const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
const visibleText = (html) => {
  const body = stripComments(html).split('<body>')[1] || '';
  return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

const ctNoComments = stripComments(ct);
const ctVisible = visibleText(ct);
const subVisible = visibleText(sub);


// --- 1. 基本 ---

test('lang は ja', () => {
  assert.match(ct, /<html lang="ja">/);
});

test('title / h1 が特定商取引法に基づく表記だと分かる', () => {
  const title = ct.match(/<title>([^<]*)<\/title>/);
  assert.ok(title);
  assert.equal(title[1], '特定商取引法に基づく表記 - スキマ');

  const h1s = ct.match(/<h1>[\s\S]*?<\/h1>/g) || [];
  assert.equal(h1s.length, 1);
  assert.match(h1s[0], /特定商取引法に基づく表記/);
});

test('meta description がある', () => {
  const d = ct.match(/<meta name="description" content="([^"]*)"/);
  assert.ok(d);
  assert.match(d[1], /Web Pro|特定商取引法/);
});

test('有料プラン専用であることが書いてある', () => {
  assert.match(ctVisible, /Web Pro/);
  assert.match(ctVisible, /無料でのご利用には適用されません/);
});


// --- 2. JS / 外部リソースを持ち込まない ---

test('JavaScript を持たない', () => {
  assert.equal(ct.includes('<script'), false);
  assert.equal(/\son(click|load|error|change|submit|input)=/i.test(ct), false);
  assert.equal(ct.includes('javascript:'), false);
});

test('外部リソースを読み込まない（自己完結した静的ページ）', () => {
  assert.equal(/<link[^>]+rel="stylesheet"/i.test(ctNoComments), false);
  assert.equal(/<(script|img|iframe|source|video|audio|object|embed)\b/i.test(ctNoComments), false);
  assert.equal(/@import|url\(\s*https?:/i.test(ctNoComments), false);
  assert.equal(ctNoComments.includes('https://'), false, '外部 URL を参照しない');
});

test('同意 UI / 購入導線を持たない（掲示専用）', () => {
  for (const tag of ['<input', '<button', '<form', '<select', '<textarea']) {
    assert.equal(ctNoComments.includes(tag), false, tag);
  }
  for (const path of ['/pricing', '/checkout', '/billing']) {
    assert.equal(ctNoComments.includes('href="' + path), false, path);
  }
});


// --- 3. 確定情報が記載されている ---

test('販売価格が記載されている（税込表記）', () => {
  assert.match(ctVisible, /月額 300 円（税込）/);
  assert.match(ctVisible, /月額 500 円（税込）/);
});

test('開始価格の適用条件と移行時期が記載されている', () => {
  assert.match(ctVisible, /2026 年 12 月 31 日までにご契約を開始/);
  assert.match(ctVisible, /2027 年に入って最初に訪れるお客様ごとの更新日/);
  assert.match(ctVisible, /2027 年 1 月 1 日以降/);
});

test('販売地域と請求通貨が日本のみ・日本円と書いてある', () => {
  assert.match(ctVisible, /日本国内のみ/);
  assert.match(ctVisible, /請求通貨は日本円/);
});

test('課金間隔・無料トライアル・自動更新が記載されている', () => {
  assert.match(ctVisible, /月額のみ/);
  assert.match(ctVisible, /無料お試し期間はありません/);
  assert.match(ctVisible, /自動的に更新/);
});

test('支払方法として Stripe が記載され、特定の決済手段を保証していない', () => {
  assert.match(ctVisible, /Stripe/);
  assert.match(ctVisible, /Stripe 側の提供状況により変わることがあります/);
  // Apple Pay / Google Pay を必ず使えると書かない
  assert.equal(/Apple Pay|Google Pay/.test(ctVisible), false);
});

test('支払時期とサービス提供時期が記載されている', () => {
  assert.match(ctVisible, /お申し込み手続きの完了時にご請求/);
  assert.match(ctVisible, /更新日に自動的にご請求/);
  assert.match(ctVisible, /初回のお支払いが成功し、当方でお支払いを確認できた後/);
  assert.match(ctVisible, /決済画面からスキマへ戻っただけでは Pro 機能は有効になりません/);
});

test('販売価格以外に必要となる費用が記載されている', () => {
  assert.match(ctVisible, /通信料金はお客様のご負担/);
  assert.match(ctVisible, /販売価格以外に当方が申し受ける費用はありません/);
});

test('解約方法と効力発生時期が記載されている', () => {
  assert.match(ctVisible, /請求ポータル/);
  assert.match(ctVisible, /現在の契約期間の末日をもって効力/);
  assert.match(ctVisible, /期間が終了するまでは Pro 機能をご利用いただけます/);
});

test('通常解約の日割り返金なしと返金例外 4 種が記載されている', () => {
  assert.match(ctVisible, /日割りでの返金も、原則として行いません/);
  for (const ex of ['重複して決済', '誤った金額', 'システム不具合', '法令上返金が必要']) {
    assert.ok(ctVisible.includes(ex), '返金例外が無い: ' + ex);
  }
});

test('提供者都合での終了時の補償が記載されている', () => {
  assert.match(ctVisible, /未経過期間に対応する金額の返金、または合理的な代替措置/);
});

test('支払い失敗時の取扱いが記載されている（7 日を権利として保証しない）', () => {
  assert.match(ctVisible, /初回のお支払いが完了しなかった場合、Pro 機能は付与されません/);
  assert.match(ctVisible, /最大 7 日間/);
  assert.match(ctVisible, /権利として保証されるものではありません/);
});

test('動作環境と 18 歳以上の条件が記載されている', () => {
  assert.match(ctVisible, /Google アカウント/);
  assert.match(ctVisible, /18 歳以上の方に限ります/);
});

test('その他の特別条件が記載されている', () => {
  assert.match(ctVisible, /同時にご契約いただける有料プランは 1 つ/);
  assert.match(ctVisible, /現時点では販売しておりません/);
});

test('連絡先メールアドレスが記載されている', () => {
  assert.match(ctNoComments, /mailto:tetsugaku4@gmail\.com/);
});


// --- 4. 事業者情報---

/** 法定表示として載っていなければならない事業者情報。**ここが正。** */
const SELLER_INFO = [
  ['販売事業者', '中谷 健一'],
  ['屋号', 'Sukima'],
  ['運営責任者', '中谷 健一'],
  ['所在地', '石川県金沢市長土塀1-1-21'],
  ['電話番号', '090-3764-0143'],
];

test('事業者情報が項目名と値の組で表示されている', () => {
  for (const [label, value] of SELLER_INFO) {
    assert.ok(ctNoComments.includes('<dt>' + label + '</dt>'),
      '項目名が無い: ' + label);
    assert.ok(ctVisible.includes(value), '値が表示されていない: ' + label);
    // 「項目名 -> 値」の順で隣り合っていること（別項目の値と入れ違っていない）
    assert.ok(ctVisible.includes(label + ' ' + value),
      '項目名と値が対応していない: ' + label);
  }
});

test('連絡先メールアドレスは 5A-5-3B から変わっていない', () => {
  assert.match(ctNoComments, /mailto:tetsugaku4@gmail\.com/);
  assert.match(ctVisible, /tetsugaku4@gmail\.com/);
});

test('電話番号は確定した 1 つだけで、別の番号を書いていない', () => {
  const phones = ctVisible.match(/0\d{1,4}-\d{1,4}-\d{3,4}/g) || [];
  assert.deepEqual(phones, ['090-3764-0143']);
});

test('確定していない情報を推測で足していない', () => {
  // インボイス登録番号は**無い**。欄ごと作らないし、架空の番号も書かない。
  assert.equal(/T\d{13}/.test(ctVisible), false, 'インボイス登録番号らしき記載');
  assert.equal(ctVisible.includes('適格請求書'), false, '登録番号の欄を作っている');
  assert.equal(ctVisible.includes('登録番号'), false, '登録番号の欄を作っている');
  assert.equal(/\d{13}/.test(ctVisible), false, '法人番号らしき記載');
  assert.equal(/〒\s*\d{3}-?\d{4}/.test(ctVisible), false, '確定していない郵便番号');
  // 法人ではない。法人格を示す語を勝手に付けない。
  for (const w of ['株式会社', '合同会社', '有限会社', '代表取締役']) {
    assert.equal(ctVisible.includes(w), false, '事業形態を推測している: ' + w);
  }
});

test('利用者向けに「未定」「TODO」等を表示していない', () => {
  for (const w of ['未定', 'TODO', 'FIXME', '準備中です', 'xxxxx', 'XXXXX',
                   'placeholder', '記入してください']) {
    assert.equal(ctVisible.includes(w), false, '可視テキストに出ている: ' + w);
  }
});

test('未記載スロットも公開停止の痕跡も残っていない', () => {
  // 4 項目が埋まったので、場所取りのコメントは消えていること。
  // HTML コメントも含めて（= ct 全体で）検査する。
  for (const marker of ['MUST BE FILLED', 'TODO', 'FIXME']) {
    assert.equal(ct.includes(marker), false, '未記載の痕跡が残っている: ' + marker);
  }
});

test('公開できる状態になっている（noindex を外してある）', () => {
  assert.equal(/<meta name="robots"[^>]*noindex/.test(ct), false,
    'noindex が残っていると法定表示が検索から隠れる');
  assert.equal(ct.includes('このページはまだ公開できる状態ではない'), false);
});


// --- 5. Subscription Terms との整合 ---

test('Subscription Terms と主要な数値が一致する', () => {
  for (const [label, ctText, subText] of [
    ['launch 価格', '300 円', '300 円'],
    ['standard 価格', '500 円', '500 円'],
    ['launch 期限', '2026 年 12 月 31 日', '2026 年 12 月 31 日'],
    ['standard 移行', '2027 年に入って最初', '2027 年に入って最初'],
    ['7 日猶予', '最大 7 日', '最大 7 日'],
    ['18 歳以上', '18 歳以上', '18 歳以上'],
    ['販売は日本のみ', '日本国内のみ', '日本国内のみ'],
  ]) {
    assert.ok(ctVisible.includes(ctText), `特商法ページに無い（${label}）`);
    assert.ok(subVisible.includes(subText), `Subscription Terms に無い（${label}）`);
  }
});

test('特商法ページの販売国が billing-config の購入可能国と矛盾しない', () => {
  assert.deepEqual([...PURCHASABLE_COUNTRIES], ['JP']);
  assert.match(ctVisible, /日本国内のみ/);
});

test('Subscription Terms と一般利用規約へリンクしている', () => {
  assert.match(ctNoComments, /href="\/terms\/subscription"/);
  assert.match(ctNoComments, /href="\/terms"/);
  assert.match(ctNoComments, /href="\/privacy"/);
  assert.match(ctNoComments, /href="\/"/);
});

test('Subscription Terms 側も published になっている', () => {
  // 特商法ページを公開する以上、参照先の規約も公開されていなければならない。
  assert.equal(SUBSCRIPTION_TERMS_CONFIG.status, 'published');
  assert.match(String(SUBSCRIPTION_TERMS_CONFIG.version), /^\d{4}-\d{2}-\d{2}(?:-\d+)?$/);
});


// --- 6. 既存ページを巻き込んでいない ---

test('一般利用規約は無変更のまま（特商法の内容が混入していない）', () => {
  assert.match(general, /<title>利用規約 - スキマ<\/title>/);
  assert.equal(general.includes('特定商取引法'), false);
  assert.equal(general.includes('/legal/commercial-transactions'), false);
});

test('Subscription Terms にも特商法ページの内容が混入していない', () => {
  assert.equal(sub.includes('特定商取引法'), false);
});

test('3 ページは別ファイル・別内容', () => {
  assert.notEqual(ct, sub);
  assert.notEqual(ct, general);
  assert.equal(ct.includes('Google Calendar API の仕様変更'), false);
});
