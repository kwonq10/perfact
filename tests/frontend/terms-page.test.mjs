// =========================================================
// Subscription Terms ページ（日本語）の静的テスト
//
//   対象: public/terms/subscription.html
//
//   このテストが守るもの:
//     - **既存の一般利用規約 public/terms.html を巻き込んでいないこと。**
//       あちらは Google OAuth 審査を通したページで、別物として扱う
//     - **ページに出ている版が config の版と一致している**こと
//       （現行版の正は billing-config.js の SUBSCRIPTION_TERMS_CONFIG）
//       （現在は published）
//     - 同意 UI / JS / 壊れたリンクを持ち込んでいないこと
//
//   ja/en の相互 hreflang と「HTML の版 == config の版」の整合は
//   このファイルの後半でまとめて固定する。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  PURCHASABLE_COUNTRIES,
  SUBSCRIPTION_TERMS_CONFIG,
} from '../../functions/api/_lib/billing-config.js';

const SUB_URL = new URL('../../public/terms/subscription.html', import.meta.url);
const GENERAL_URL = new URL('../../public/terms.html', import.meta.url);

const sub = fs.readFileSync(SUB_URL, 'utf8');
const general = fs.readFileSync(GENERAL_URL, 'utf8');

/** HTML コメントを落とす（コメントは開発者向けで、利用者には見えない）。 */
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/** 利用者に見えるテキストだけを取り出す。 */
function visibleText(html) {
  const body = stripComments(html).split('<body>')[1] || '';
  return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const subVisible = visibleText(sub);
const subNoComments = stripComments(sub);

/**
 * 現行版と、その版に対応する ja / en の最終更新日表記。
 *
 * **版そのものはここに直書きしない。** config を正とし、
 * 「HTML の表示が config から導ける値と一致するか」だけを検証する。
 * こうしておくと版を上げたときにテストの書き換えが要らず、
 * それでいて config だけ上げて HTML を直し忘れたら落ちる。
 */
const TERMS_VERSION = SUBSCRIPTION_TERMS_CONFIG.version;
const [V_Y, V_M, V_D] = String(TERMS_VERSION).split('-').slice(0, 3).map(Number);
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const JA_UPDATED = `最終更新日: ${V_Y}年${V_M}月${V_D}日`;
const EN_UPDATED = `Last updated: ${EN_MONTHS[V_M - 1]} ${V_D}, ${V_Y}`;


// --- 1. 基本構造 ---

test('lang は ja', () => {
  assert.match(sub, /<html lang="ja">/);
});

test('title / meta description が Subscription Terms だと分かる', () => {
  const title = sub.match(/<title>([^<]*)<\/title>/);
  assert.ok(title, 'title がある');
  assert.match(title[1], /サブスクリプション利用規約/);

  const desc = sub.match(/<meta name="description" content="([^"]*)"/);
  assert.ok(desc, 'meta description がある');
  assert.match(desc[1], /サブスクリプション|Web Pro/);
});

test('h1 が 1 つだけあり、一般利用規約と区別できる', () => {
  const h1s = sub.match(/<h1>[\s\S]*?<\/h1>/g) || [];
  assert.equal(h1s.length, 1);
  assert.match(h1s[0], /サブスクリプション利用規約/);
});

test('条項の見出し構造がある（section と h2 が 1 対 1）', () => {
  const sections = subNoComments.match(/<section>/g) || [];
  const h2s = subNoComments.match(/<h2>/g) || [];
  assert.ok(sections.length >= 12, '条項が 12 以上ある: ' + sections.length);
  assert.equal(sections.length, h2s.length, 'section と h2 の数が一致する');
});

test('確定仕様に対応する条項が揃っている', () => {
  for (const heading of ['適用範囲', '料金', '支払い', '自動更新', '解約', '返金',
                         'プランの変更', '支払いの失敗', 'アカウントの削除',
                         '本規約の変更', 'お問い合わせ']) {
    assert.ok(subNoComments.includes(heading), '見出しが無い: ' + heading);
  }
});


// --- 2. リンク ---

test('一般利用規約とプライバシーポリシーへのリンクがある', () => {
  assert.match(subNoComments, /href="\/terms"/);
  assert.match(subNoComments, /href="\/privacy"/);
});

test('トップページへ戻れる', () => {
  assert.match(subNoComments, /href="\/"/);
});

test('英語ページへの言語切替リンクがある', () => {
  assert.match(subNoComments, /href="\/terms\/subscription\/en"/);
});

test('課金導線（Pricing / Checkout）へのリンクをまだ置かない', () => {
  for (const path of ['/pricing', '/checkout', '/billing']) {
    assert.equal(subNoComments.includes('href="' + path), false, path);
  }
});

test('日本語ページに ja / en の hreflang が入っている', () => {
  assert.match(sub, /<link rel="alternate" hreflang="ja" href="https:\/\/sukimacalendar\.com\/terms\/subscription">/);
  assert.match(sub, /<link rel="alternate" hreflang="en" href="https:\/\/sukimacalendar\.com\/terms\/subscription\/en">/);
});


// --- 3. 掲示専用であること ---

test('JavaScript を持たない', () => {
  assert.equal(sub.includes('<script'), false, '<script> が無い');
  assert.equal(/\son(click|load|error|change|submit|input)=/i.test(sub), false,
    'インラインイベントハンドラが無い');
  assert.equal(sub.includes('javascript:'), false);
});

test('同意 UI（checkbox / button / form）を持たない', () => {
  for (const tag of ['<input', '<button', '<form', '<select', '<textarea']) {
    assert.equal(subNoComments.includes(tag), false, tag + ' が無い');
  }
});

test('外部リソースを読み込まない（自己完結した静的ページ）', () => {
  // hreflang は絶対 URL だが「読み込み」ではないので対象外にする。
  // 禁止するのは外部からの取得が発生するもの。
  assert.equal(/<link[^>]+rel="stylesheet"/i.test(subNoComments), false, '外部 stylesheet');
  assert.equal(/<(script|img|iframe|source|video|audio|object|embed)/i.test(subNoComments), false,
    '外部読み込みを伴う要素');
  assert.equal(/@import|url\(\s*https?:/i.test(subNoComments), false, 'CSS からの外部取得');
});


// --- 4. published なので版と最終更新日を出す ---

test('前提: Subscription Terms 設定は published', () => {
  // このテストの意味を成立させる前提。
  assert.equal(SUBSCRIPTION_TERMS_CONFIG.status, 'published');
  assert.match(String(TERMS_VERSION), /^\d{4}-\d{2}-\d{2}(?:-\d+)?$/);
});

test('日本語ページに config と同じ版が表示されている', () => {
  assert.ok(subVisible.includes(`規約バージョン: ${TERMS_VERSION}`),
    '版が config と一致していない: ' + TERMS_VERSION);
  assert.equal(/draft/i.test(subVisible), false, '「draft」が見えている');
});

test('日本語ページの最終更新日が版と一致している', () => {
  assert.ok(subVisible.includes(JA_UPDATED),
    `最終更新日が版とずれている（期待: ${JA_UPDATED}）`);
});

test('未完成であることを画面で強調しない', () => {
  for (const word of ['未完成', 'TODO', 'placeholder', '工事中', 'coming soon']) {
    assert.equal(subVisible.toLowerCase().includes(word.toLowerCase()), false, word);
  }
});

test('版の表示領域の説明コメントが残っている', () => {
  // 版を上げるときにどこを直すのかが分かるようにしておく。
  assert.match(sub, /<!--[\s\S]*?版[\s\S]*?表示領域[\s\S]*?-->/);
});


// --- 5. 既存の一般利用規約を巻き込んでいないこと ---

test('既存 public/terms.html は一般利用規約のまま', () => {
  assert.match(general, /<title>利用規約 - スキマ<\/title>/);
  assert.match(general, /<h1>スキマ - 利用規約<\/h1>/);
});

test('既存 public/terms.html にサブスクリプション規約が混入していない', () => {
  assert.equal(general.includes('サブスクリプション利用規約'), false);
  assert.equal(general.includes('Subscription Terms'), false);
  assert.equal(general.includes('/terms/subscription'), false);
});

test('2 ページは別ファイル・別内容', () => {
  assert.notEqual(sub, general);
  // **一般規約の本文（OAuth 審査済み文面）を流用していない。**
  // 単語単位ではなく、あちらに固有の一文が丸ごと入っていないかで判定する。
  // 「Google Calendar API」のような語は、サブスク規約側でも
  // 提供終了条項の説明として正当に登場し得るため判定に使わない。
  const generalOnlySentences = [
    '本サービスが表示する空き時間の計算結果について、その完全性・正確性を保証するものではありません。',
    '本規約の解釈にあたっては、日本法を準拠法とします。',
    '専属的合意管轄裁判所とします',
  ];
  for (const sentence of generalOnlySentences) {
    assert.equal(subNoComments.includes(sentence), false, '一般規約の文が混入: ' + sentence);
  }
});

test('準拠法・管轄を重複して定義せず、一般利用規約へ委ねている', () => {
  // 一般規約に既に定めがある。ここで別の管轄を書くと矛盾する。
  assert.equal(/準拠法/.test(subVisible), true, '委ねている旨の言及はある');
  assert.equal(/専属的合意管轄|第一審/.test(subVisible), false, '管轄を独自に定義しない');
});


// =========================================================
// 英語ページと ja / en の対称性
//
//   ja が原本、en がその対応版。**条項は 1 対 1** に保つ。
//   版・最終更新日の表示は SUBSCRIPTION_TERMS_CONFIG と連動させ、
//   published になったらこのテストが落ちて
//   「HTML 側にも版を入れる必要がある」と気付ける形にする。
// =========================================================

const EN_URL = new URL('../../public/terms/subscription/en.html', import.meta.url);
const en = fs.readFileSync(EN_URL, 'utf8');
const enNoComments = stripComments(en);
const enVisible = visibleText(en);

/** 両ページを同じ観点で回すための組。 */
const PAGES = [
  { name: 'ja', html: sub, noComments: subNoComments, visible: subVisible, lang: 'ja' },
  { name: 'en', html: en, noComments: enNoComments, visible: enVisible, lang: 'en' },
];

const HREFLANG_JA = '<link rel="alternate" hreflang="ja" href="https://sukimacalendar.com/terms/subscription">';
const HREFLANG_EN = '<link rel="alternate" hreflang="en" href="https://sukimacalendar.com/terms/subscription/en">';


// --- 6. 英語ページの基本 ---

test('英語ページの lang は en', () => {
  assert.match(en, /<html lang="en">/);
});

test('英語ページの title / meta description が Subscription Terms だと分かる', () => {
  const title = en.match(/<title>([^<]*)<\/title>/);
  assert.ok(title);
  assert.equal(title[1], 'Subscription Terms - Sukima');

  const desc = en.match(/<meta name="description" content="([^"]*)"/);
  assert.ok(desc);
  assert.match(desc[1], /Subscription Terms|Web Pro/);
});

test('英語ページの h1 は 1 つで Sukima - Subscription Terms', () => {
  const h1s = en.match(/<h1>[\s\S]*?<\/h1>/g) || [];
  assert.equal(h1s.length, 1);
  assert.match(h1s[0], /Sukima - Subscription Terms/);
});


// --- 7. 相互リンクと hreflang ---

test('日本語ページから英語ページへリンクしている', () => {
  assert.match(subNoComments, /href="\/terms\/subscription\/en"/);
  assert.match(subVisible, /English/);
});

test('英語ページから日本語ページへリンクしている', () => {
  assert.match(enNoComments, /href="\/terms\/subscription"/);
  assert.match(enVisible, /日本語/);
});

test('両ページに同じ hreflang 2 本が入っている（対称）', () => {
  for (const page of PAGES) {
    assert.ok(page.html.includes(HREFLANG_JA), page.name + ' に hreflang=ja が無い');
    assert.ok(page.html.includes(HREFLANG_EN), page.name + ' に hreflang=en が無い');
  }
});

test('hreflang の href が実在するページを指している', () => {
  // ja -> public/terms/subscription.html, en -> public/terms/subscription/en.html
  assert.ok(fs.existsSync(new URL('../../public/terms/subscription.html', import.meta.url)));
  assert.ok(fs.existsSync(EN_URL));
});

test('hreflang は ja / en の 2 本だけ（x-default は今回入れない）', () => {
  for (const page of PAGES) {
    const links = page.html.match(/<link rel="alternate"[^>]*>/g) || [];
    assert.equal(links.length, 2, page.name);
    assert.equal(page.html.includes('x-default'), false, page.name);
  }
});

test('canonical は今回入れない（既存サイトに前例が無い）', () => {
  for (const page of PAGES) {
    assert.equal(/rel="canonical"/.test(page.html), false, page.name);
  }
});


// --- 8. ja / en の構造対応 ---

test('条項数が ja / en で一致する', () => {
  const jaSections = (subNoComments.match(/<section>/g) || []).length;
  const enSections = (enNoComments.match(/<section>/g) || []).length;
  assert.equal(jaSections, 13, 'ja の条項数');
  assert.equal(enSections, 13, 'en の条項数');
  assert.equal(jaSections, enSections);
});

test('section と h2 が ja / en とも 1 対 1', () => {
  for (const page of PAGES) {
    const sections = (page.noComments.match(/<section>/g) || []).length;
    const h2s = (page.noComments.match(/<h2>/g) || []).length;
    assert.equal(sections, h2s, page.name);
  }
});

test('条項番号が ja / en とも 1〜13 で連番になっている', () => {
  for (const page of PAGES) {
    const nums = [...page.noComments.matchAll(/<h2>(\d+)\./g)].map((m) => Number(m[1]));
    assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], page.name);
  }
});

test('条項の意味が ja / en で対応している（順序も一致）', () => {
  const expected = [
    ['適用範囲', 'Scope'],
    ['サブスクリプションプラン', 'Subscription Plans'],
    ['料金・通貨・税', 'Fees, Currency and Taxes'],
    ['支払い方法と決済事業者', 'Payment and Payment Processor'],
    ['契約期間と自動更新', 'Subscription Period and Automatic Renewal'],
    ['プランの変更', 'Plan Changes'],
    ['支払いの失敗', 'Payment Failures'],
    ['解約', 'Cancellation'],
    ['返金', 'Refunds'],
    ['提供内容の変更・終了', 'Changes to and Discontinuation of the Service'],
    ['アカウントの削除', 'Account Deletion'],
    ['本規約の変更', 'Changes to These Terms'],
    ['お問い合わせ', 'Contact'],
  ];
  const jaHeads = (subNoComments.match(/<h2>[^<]*<\/h2>/g) || []).map((h) => h.replace(/<[^>]*>/g, ''));
  const enHeads = (enNoComments.match(/<h2>[^<]*<\/h2>/g) || []).map((h) => h.replace(/<[^>]*>/g, ''));
  assert.equal(jaHeads.length, expected.length);
  assert.equal(enHeads.length, expected.length);
  expected.forEach(([ja, enText], i) => {
    assert.ok(jaHeads[i].includes(ja), `ja #${i + 1}: ${jaHeads[i]} に ${ja} が無い`);
    assert.ok(enHeads[i].includes(enText), `en #${i + 1}: ${enHeads[i]} に ${enText} が無い`);
  });
});


// --- 9. 掲示専用であること（en 側も同じ制約） ---

test('英語ページも JavaScript を持たない', () => {
  assert.equal(en.includes('<script'), false);
  assert.equal(/\son(click|load|error|change|submit|input)=/i.test(en), false);
  assert.equal(en.includes('javascript:'), false);
});

test('英語ページも同意 UI を持たない', () => {
  for (const tag of ['<input', '<button', '<form', '<select', '<textarea']) {
    assert.equal(enNoComments.includes(tag), false, tag);
  }
});

test('英語ページも課金導線を持たない', () => {
  for (const path of ['/pricing', '/checkout', '/billing']) {
    assert.equal(enNoComments.includes('href="' + path), false, path);
  }
});

test('英語ページも外部リソースを読み込まない', () => {
  assert.equal(/<link[^>]+rel="stylesheet"/i.test(enNoComments), false);
  assert.equal(/<(script|img|iframe|source|video|audio|object|embed)\b/i.test(enNoComments), false);
  assert.equal(/@import|url\(\s*https?:/i.test(enNoComments), false);
});


// --- 10. footer と内部リンクの健全性 ---

test('英語 footer は日本語しか無いページであることを明示してリンクする', () => {
  // public/terms.html と public/privacy.html は lang="ja" のみで英語版が無い
  // （extension/privacy/en.html は拡張機能専用の別文書）。
  // 言語をラベルで示してから遷移させる。
  assert.match(enNoComments, /General Terms \(Japanese\)/);
  assert.match(enNoComments, /Privacy Policy \(Japanese\)/);
  assert.match(enNoComments, /href="\/terms"/);
  assert.match(enNoComments, /href="\/privacy"/);
});

test('前提: 一般利用規約とプライバシーポリシーに英語版は存在しない', () => {
  // この前提が崩れたら英語 footer のラベルを見直す。
  const general = fs.readFileSync(GENERAL_URL, 'utf8');
  const privacy = fs.readFileSync(new URL('../../public/privacy.html', import.meta.url), 'utf8');
  assert.match(general, /<html lang="ja">/);
  assert.match(privacy, /<html lang="ja">/);
  assert.equal(fs.existsSync(new URL('../../public/terms/en.html', import.meta.url)), false);
  assert.equal(fs.existsSync(new URL('../../public/privacy/en.html', import.meta.url)), false);
});

test('日本語 footer は日本語ページへリンクする', () => {
  assert.match(subNoComments, /一般利用規約/);
  assert.match(subNoComments, /プライバシーポリシー/);
});

test('両ページの内部リンクがすべて実在する（壊れたリンクが無い）', () => {
  const publicDir = new URL('../../public/', import.meta.url);
  const resolves = (href) => {
    if (href === '/') return fs.existsSync(new URL('index.html', publicDir));
    const clean = href.replace(/^\//, '').replace(/\/$/, '');
    return fs.existsSync(new URL(clean + '.html', publicDir))
        || fs.existsSync(new URL(clean + '/index.html', publicDir));
  };
  for (const page of PAGES) {
    const hrefs = [...page.noComments.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    const internal = hrefs.filter((h) => h.startsWith('/'));
    assert.ok(internal.length > 0, page.name + ' に内部リンクがある');
    for (const href of internal) {
      assert.ok(resolves(href), `${page.name}: 壊れたリンク ${href}`);
    }
  }
});


// --- 11. config と HTML の整合（published になったら落ちる） ---

test('SUBSCRIPTION_TERMS_CONFIG.locales は ja / en で、各 locale のページが実在する', () => {
  assert.deepEqual([...SUBSCRIPTION_TERMS_CONFIG.locales], ['ja', 'en']);
  const files = {
    ja: new URL('../../public/terms/subscription.html', import.meta.url),
    en: EN_URL,
  };
  for (const locale of SUBSCRIPTION_TERMS_CONFIG.locales) {
    assert.ok(files[locale], 'ページの割り当てが無い locale: ' + locale);
    assert.ok(fs.existsSync(files[locale]), 'ページが無い locale: ' + locale);
  }
});

test('版の表示は config の status と一致する（片方だけ直したら落ちる）', () => {
  const { status, version } = SUBSCRIPTION_TERMS_CONFIG;

  if (status === 'published') {
    // 公開後は **両ページに config と同じ版が見えていなければならない**。
    assert.ok(typeof version === 'string' && version.length > 0,
      'published なのに config の版が無い');
    for (const page of PAGES) {
      assert.ok(page.visible.includes(version),
        `${page.name} に版 ${version} が表示されていない。`
        + 'config の版を変えたら HTML の版表記も同時に直すこと');
      assert.ok(page.noComments.includes('class="updated"'),
        `${page.name} の版・最終更新日の表示スロットが無効になっている`);
    }
    return;
  }

  // draft のあいだは **両ページとも版を出さない**。
  //
  // 「version」「版」という語そのものは本文中に正当に現れる
  // （第 11 条「同意した規約の版 / the version you agreed to」）。
  // 判定するのは **版を表示するスロットが有効になっていないか**と
  // **版の値そのものが出ていないか**の 2 点。
  for (const page of PAGES) {
    assert.equal(page.noComments.includes('class="updated"'), false,
      `${page.name} の版・最終更新日の表示スロットが有効になっている`);
    assert.equal(/(規約バージョン|Version:)\s*\d/.test(page.visible), false,
      `${page.name} に版の値が見えている`);
    assert.equal(/\d{4}-\d{2}-\d{2}/.test(page.visible), false,
      `${page.name} に版形式の日付が見えている`);
    assert.equal(/draft/i.test(page.visible), false, `${page.name} に draft が見えている`);
  }
});

test('published なので、両ページとも同じ版と最終更新日を表示する', () => {
  if (SUBSCRIPTION_TERMS_CONFIG.status === 'published') {
    // ja / en で版がずれていないこと。**片方だけ上げたらここで落ちる。**
    assert.ok(subVisible.includes(`規約バージョン: ${TERMS_VERSION}`), 'ja の版');
    assert.ok(enVisible.includes(`Version: ${TERMS_VERSION}`), 'en の版');
    // 最終更新日も版から導ける値で一致していること
    assert.ok(subVisible.includes(JA_UPDATED), 'ja の最終更新日: ' + JA_UPDATED);
    assert.ok(enVisible.includes(EN_UPDATED), 'en の最終更新日: ' + EN_UPDATED);
    return;
  }
  // 本文には「2026 年 12 月 31 日」「December 31, 2026」のような
  // **契約条件としての日付**が正当に現れるため、日付の有無では判定しない。
  // 最終更新日の表示スロット（.updated）が無いことで判定する。
  for (const page of PAGES) {
    assert.equal(page.noComments.includes('class="updated"'), false,
      `${page.name} に最終更新日の表示スロットがある`);
    assert.equal(/最終更新日|Last updated/i.test(page.visible), false,
      `${page.name} に最終更新日が見えている`);
  }
});

test('両ページに版の表示領域の説明コメントが残っている', () => {
  assert.match(sub, /<!--[\s\S]*?版[\s\S]*?表示領域[\s\S]*?-->/);
  assert.match(en, /<!--[\s\S]*?Version[\s\S]*?display area[\s\S]*?-->/);
});

test('英語ページも「未完成」を画面で強調しない', () => {
  for (const word of ['TODO', 'placeholder', 'under construction', 'coming soon', 'draft']) {
    assert.equal(enVisible.toLowerCase().includes(word.toLowerCase()), false, word);
  }
});

test('英語ページにも一般規約との違いが書いてある（混同防止）', () => {
  assert.match(enVisible, /General Terms of Service/);
  // ja 側と同じ判定。第 10 条で Google Calendar API に触れるのは正当なので
  // 語ではなく一般規約に固有の一文で流用を検出する（日本語のため en には現れない）。
  assert.equal(enNoComments.includes('本サービスが表示する空き時間の計算結果'), false);
  assert.equal(enNoComments.includes('日本法を準拠法とします'), false);
});


// =========================================================
// 日本語本文
//
//   本文は入ったが **published にはしていない**。
//   config は draft / version null のままで、ページにも版を出さない。
//   英語ページは 5A-5-2 まで本文を入れない（骨格のまま）。
// =========================================================

/** section 単位に本文（h2 を除いた中身）を取り出す。 */
function sectionBodies(noComments) {
  return [...noComments.matchAll(/<section>([\s\S]*?)<\/section>/g)]
    .map((m) => m[1].replace(/<h2>[\s\S]*?<\/h2>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

test('日本語ページは 13 条すべてに本文が入っている', () => {
  const bodies = sectionBodies(subNoComments);
  assert.equal(bodies.length, 13);
  bodies.forEach((body, i) => {
    assert.ok(body.length > 40, `第 ${i + 1} 条の本文が短すぎる: "${body}"`);
  });
});

test('日本語本文が 確定仕様と一致する（金額・期日・猶予）', () => {
  const t = subVisible;
  for (const fact of [
    '300 円', '500 円', '2.99', '4.99',
    '2026 年 12 月 31 日',   // launch 適用期限
    '2027 年',               // standard への移行
    '7 日',                  // past_due 猶予
    '週 3 回',               // free quota
    '月払いのみ', '無料お試し期間はありません',
  ]) {
    assert.ok(t.includes(fact), '確定仕様が本文に無い: ' + fact);
  }
});

test('日本語本文が Extension Pro / All Pro を販売中のように書いていない', () => {
  assert.match(subVisible, /Extension Pro/);
  assert.match(subVisible, /準備中|販売しておらず/);
  assert.equal(/Extension Pro[^。]{0,20}(ご契約いただけます|購入できます)/.test(subVisible), false);
});

test('日本語本文が例外を認めない断定的な返金拒否をしていない', () => {
  assert.equal(subVisible.includes('一切返金'), false);
  assert.match(subVisible, /原則として行いません/);
  assert.match(subVisible, /消費者保護に関する法令/);
});

test('7 日の猶予を権利として保証していない', () => {
  assert.match(subVisible, /権利として保証されるものではありません/);
});

test('アカウント削除時の即時解約と期末解約の違いが書いてある', () => {
  assert.match(subVisible, /即時解約/);
  assert.match(subVisible, /期末解約/);
});

test('一般利用規約との優先関係が冒頭に書いてある', () => {
  assert.match(subVisible, /一般利用規約/);
  assert.match(subVisible, /優先/);
});

test('日本語本文は published 済みの config と対応している', () => {
  assert.equal(SUBSCRIPTION_TERMS_CONFIG.status, 'published');
  assert.ok(subVisible.includes(`規約バージョン: ${TERMS_VERSION}`));
});

test('「準備中」の案内は残っているが、規約自体は正式なものだと書いてある', () => {
  // 有料プランの提供開始はまだなので「準備中」は事実。
  // ただし規約は published なので、「あとで正式版を載せる」とは書かない。
  assert.match(subVisible, /準備中/);
  assert.match(subVisible, /提供開始時に適用される正式な規約/);
  assert.equal(subVisible.includes('本ページに正式な規約を掲載します'), false);
});

test('英語ページも 13 条すべてに本文が入っている', () => {
  const bodies = sectionBodies(enNoComments);
  assert.equal(bodies.length, 13);
  bodies.forEach((body, i) => {
    assert.ok(body.length > 40, `Section ${i + 1} の本文が短すぎる: "${body}"`);
  });
});

test('日本語ページも JS / 同意 UI / 課金導線を持たないまま', () => {
  assert.equal(sub.includes('<script'), false);
  for (const tag of ['<input', '<button', '<form']) {
    assert.equal(subNoComments.includes(tag), false, tag);
  }
  for (const path of ['/pricing', '/checkout', '/billing']) {
    assert.equal(subNoComments.includes('href="' + path), false, path);
  }
});


// =========================================================
// ja / en の意味整合（semantic parity）
//
//   翻訳文字列の一致ではなく、**確定仕様が両言語に存在すること**を固定する。
//   ja が原本、en がその対応版。片方だけ数字や条件が変わったら落ちる。
// =========================================================

/**
 * 確定仕様ごとの [観点, ja に必ずある文字列, en に必ずある文字列]。
 * 製品仕様（Confirmed Product Decisions）が正。
 */
const PARITY = [
  ['JPY launch',          '300 円',                     'JPY 300 per month (tax included)'],
  ['JPY standard',        '500 円',                     'JPY 500 per month (tax included)'],
  ['USD launch',          '2.99 米ドル',                 'USD 2.99 per month, plus applicable taxes'],
  ['USD standard',        '4.99 米ドル',                 'USD 4.99 per month, plus applicable taxes'],
  ['launch 期限',          '2026 年 12 月 31 日',         'December 31, 2026'],
  ['standard 移行',        '2027 年に入って最初',          'first renewal date in 2027'],
  ['2027 新規・再契約',     '2027 年 1 月 1 日以降',        'January 1, 2027'],
  ['free quota',          '週 3 回',                    '3 searches per week'],
  ['繰越なし',             '繰り越すことはできません',       'do not carry over'],
  ['timezone 基準',        'タイムゾーンを基準',            'based on your own time zone'],
  ['7 日猶予',             '最大 7 日',                   'up to seven days'],
  ['猶予は権利でない',       '権利として保証されるものではありません', 'not guaranteed as a right'],
  ['月払いのみ',           '月払いのみ',                   'monthly only'],
  ['年払いなし',           '年払いのご用意はありません',      'do not offer annual billing'],
  ['無料試用なし',          '無料お試し期間はありません',      'no free trial'],
  ['自動更新',             '自動的に更新',                 'renews automatically'],
  ['初回支払い後に有効',     '初回のお支払いが完了したことを確認できた後',
                           'after we have confirmed that your first payment completed'],
  ['初回失敗は付与なし',     'Pro 機能は付与されません',       'Pro features are not granted'],
  ['upgrade 即時 + 日割り', '日割りで調整',                 'prorated over the remaining period'],
  ['downgrade 次回更新',    '次回の更新日から',              'from your next renewal date'],
  ['期末解約',             '期間の末日をもって効力',         'takes effect at the end of your current subscription period'],
  ['解約の取消',           '取り消すことができます',         'undo the cancellation request'],
  ['通常解約は返金なし',     '日割りでの返金は行いません',      'do not provide a prorated refund'],
  ['返金は原則なし',        '原則として行いません',           'generally do not provide refunds'],
  ['消費者権利を制限しない', '消費者保護に関する法令',         'consumer protection law'],
  ['削除時は即時解約',      '即時に解約',                   'cancel your subscription immediately'],
  ['解約確認後に削除',      '解約が完了したことを確認',        'confirmed that the cancellation completed'],
  ['8 条との区別',         '第 8 条の期末解約とは異なり',      'unlike the end-of-period cancellation in Section 8'],
  ['同意記録の保持',        'アカウント削除後も保持',          'kept after your account is deleted'],
  ['記録に PII なし',      'メールアドレスや Google アカウントの識別情報',
                           'do not contain your email address'],
  ['Coming Soon',         '販売しておらず',                'not on sale and cannot be subscribed to'],
  // --- 初期販売は日本のみ ---
  ['販売は日本のみ',       '現在ご契約いただけるのは日本国内のみ',
                          'Subscriptions are currently available in Japan only'],
  ['他 4 国は停止中',      '現在は受け付けておりません',      'not available at this time'],
  ['将来提供予定',         '今後の提供を予定',              'We plan to offer them in the future'],
  ['停止中の国名',         'オーストラリア',                'Australia'],
  ['18 歳以上',           '18 歳以上の方',                'at least 18 years old'],
  ['無料は年齢制限なし',    '無料でのご利用については、この年齢の条件はありません',
                          'does not apply to using Sukima for free'],
  ['提供終了時の返金',      '未経過期間に対応する金額の返金、または合理的な代替措置',
                          'refund the amount corresponding to the unused part of that period, or provide a reasonable equivalent'],
  ['法令が優先',           '法令の定めが優先します',         'that law prevails'],
  ['通常解約は従来どおり',  '通常の解約（第 8 条）',          'Ordinary cancellation by you (Section 8) is unchanged'],
  ['通貨は契約前のみ',      'ご契約前のみ',                  'only before you subscribe'],
  ['一般規約と併用',        '一般利用規約',                  'General Terms of Service'],
  ['有料事項で優先',        '優先して適用',                  'take precedence'],
];

test('ja / en に確定仕様が 1 対 1 で存在する', () => {
  for (const [name, jaText, enText] of PARITY) {
    assert.ok(subVisible.includes(jaText), `ja に無い（${name}）: ${jaText}`);
    assert.ok(enVisible.includes(enText), `en に無い（${name}）: ${enText}`);
  }
});

test('準拠法・管轄は en でも一般利用規約へ委ねている', () => {
  assert.match(enVisible, /governing law and jurisdiction are as set out in the General Terms/i);
  assert.equal(/exclusive jurisdiction|governed by the laws of/i.test(enVisible), false,
    'en で独自に準拠法・管轄を定めない');
});

test('英語版が日本語版より強い断定をしていない', () => {
  for (const phrase of ['under any circumstances', 'no refunds whatsoever', 'in all cases',
                        'without exception', 'irrevocably', 'you waive']) {
    assert.equal(enVisible.toLowerCase().includes(phrase), false, '強すぎる表現: ' + phrase);
  }
  // 7 日猶予を保証として書いていない
  assert.equal(/we guarantee|is guaranteed/i.test(enVisible), false);
  assert.match(enVisible, /not guaranteed as a right/);
});

test('英語版が推測で各国の消費者法を追加していない（法務確認待ち）', () => {
  for (const law of ['cooling-off', 'Consumer Rights Act', 'Australian Consumer Law',
                     'GDPR', 'Distance Selling', 'statutory right to cancel']) {
    assert.equal(enVisible.toLowerCase().includes(law.toLowerCase()), false,
      '未確認の法的概念を追加している: ' + law);
  }
});

test('英語版が Extension Pro / All Pro を販売中のように書いていない', () => {
  assert.match(enVisible, /Extension Pro/);
  assert.match(enVisible, /being prepared/);
  assert.equal(/Extension Pro[^.]{0,40}(is available|can be purchased)/i.test(enVisible), false);
});

test('en は shall を多用していない（自然な SaaS English）', () => {
  const shalls = enVisible.match(/\bshall\b/gi) || [];
  assert.ok(shalls.length <= 2, 'shall が多い: ' + shalls.length);
});

test('英語版の条文数・番号は日本語版と一致したまま', () => {
  const jaNums = [...subNoComments.matchAll(/<h2>(\d+)\./g)].map((m) => Number(m[1]));
  const enNums = [...enNoComments.matchAll(/<h2>(\d+)\./g)].map((m) => Number(m[1]));
  assert.deepEqual(jaNums, enNums);
  assert.deepEqual(jaNums, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

test('英語本文も published 済みの config と対応している', () => {
  assert.equal(SUBSCRIPTION_TERMS_CONFIG.status, 'published');
  assert.ok(enVisible.includes(`Version: ${TERMS_VERSION}`));
});

test('英語版も「準備中」の案内を残しつつ、規約は正式だと書いてある', () => {
  assert.match(enVisible, /currently being prepared/);
  assert.match(enVisible, /These are the final Subscription Terms/);
  assert.equal(enVisible.includes('will be published on this page'), false);
});


// =========================================================
// 事業方針を本文へ反映したことの固定
// =========================================================

test('ja / en とも「現在の販売は日本のみ」と書いてある', () => {
  assert.match(subVisible, /現在ご契約いただけるのは日本国内のみ/);
  assert.match(subVisible, /請求通貨は日本円/);
  assert.match(enVisible, /Subscriptions are currently available in Japan only/);
  assert.match(enVisible, /billed in Japanese yen/);
});

test('ja / en とも他 4 国を「販売中」と読める書き方をしていない', () => {
  // 旧ドラフトの表現が残っていないこと
  assert.equal(subVisible.includes('現在の販売対象は、日本・アメリカ合衆国'), false);
  assert.equal(subVisible.includes('当初は米ドル建て'), false);
  assert.equal(enVisible.includes('We currently sell in Japan, the United States'), false);
  assert.equal(enVisible.includes('billed in US dollars for now'), false);
  // 停止中であることが書かれていること
  assert.match(subVisible, /現在は受け付けておりません/);
  assert.match(enVisible, /not available at this time/);
});

test('ja / en とも他 4 国は将来提供予定として書いてある', () => {
  assert.match(subVisible, /今後の提供を予定/);
  assert.match(enVisible, /We plan to offer them in the future/);
});

test('Terms の販売国の記述が billing-config の購入可能国と矛盾しない', () => {
  // config が日本のみ販売のあいだは、Terms も日本のみと書いていること。
  // 販売国を広げるときは config と Terms を同時に直す必要がある。
  assert.deepEqual([...PURCHASABLE_COUNTRIES], ['JP']);
  assert.match(subVisible, /日本国内のみ/);
  assert.match(enVisible, /in Japan only/);
});

test('ja / en とも有料契約は 18 歳以上と書いてある', () => {
  assert.match(subVisible, /18 歳以上の方/);
  assert.match(enVisible, /at least 18 years old/);
});

test('18 歳以上の条件を無料利用まで広げていない', () => {
  assert.match(subVisible, /無料でのご利用については、この年齢の条件はありません/);
  assert.match(enVisible, /does not apply to using Sukima for free/);
});

test('ja / en とも提供終了時は未経過期間の返金または代替措置と書いてある', () => {
  assert.match(subVisible, /未経過期間に対応する金額の返金、または合理的な代替措置/);
  assert.match(enVisible, /refund the amount corresponding to the unused part of that period/);
  assert.match(enVisible, /reasonable equivalent/);
});

test('提供終了時の対応で法令が優先すると書いてある', () => {
  assert.match(subVisible, /法令の定めが優先します/);
  assert.match(enVisible, /that law prevails/);
});

test('通常解約の返金ルールは変えていない', () => {
  assert.match(subVisible, /日割りでの返金は行いません/);
  assert.match(enVisible, /do not provide a prorated refund/);
  assert.match(subVisible, /通常の解約（第 8 条）/);
  assert.match(enVisible, /Ordinary cancellation by you \(Section 8\) is unchanged/);
});

test('規約変更の手続きは従来どおり厳しいまま', () => {
  assert.match(subVisible, /あらかじめお知らせしたうえで、原則として次回の更新日以降に適用/);
  assert.match(subVisible, /適用開始日までに解約/);
  assert.match(enVisible, /notify you in advance/);
  assert.match(enVisible, /you can cancel before it takes effect/);
});

test('クーリングオフを絶対に否定する断定を追加していない', () => {
  for (const t of [subVisible, enVisible]) {
    assert.equal(/クーリングオフはありません|no cooling-off|no right to cancel/i.test(t), false);
  }
  // 法令上の権利を妨げない構造は維持
  assert.match(subVisible, /消費者保護に関する法令/);
  assert.match(enVisible, /consumer protection law/);
});

test('Stripe への同意を包括的に強制する記述を追加していない', () => {
  for (const t of [subVisible, enVisible]) {
    assert.equal(/すべての利用規約へ同意したものとみなし|agree to all of Stripe/i.test(t), false);
  }
});

test('日本語版の絶対優先条項を追加していない', () => {
  for (const t of [subVisible, enVisible]) {
    assert.equal(/日本語版が優先|Japanese version (shall )?prevail/i.test(t), false);
  }
});

test('Subscription Terms 側に独自の準拠法・管轄を作っていない', () => {
  assert.equal(/専属的合意管轄|第一審/.test(subVisible), false);
  assert.equal(/exclusive jurisdiction|governed by the laws of/i.test(enVisible), false);
});

test('13 条の条数・番号・順序は変えていない', () => {
  const jaNums = [...subNoComments.matchAll(/<h2>(\d+)\./g)].map((m) => Number(m[1]));
  const enNums = [...enNoComments.matchAll(/<h2>(\d+)\./g)].map((m) => Number(m[1]));
  assert.deepEqual(jaNums, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(enNums, jaNums);
});

test('方針反映後も ja / en は同じ版で published のまま', () => {
  assert.equal(SUBSCRIPTION_TERMS_CONFIG.status, 'published');
  for (const page of PAGES) {
    assert.ok(page.noComments.includes('class="updated"'), page.name);
    assert.ok(page.visible.includes(TERMS_VERSION), page.name);
  }
});
