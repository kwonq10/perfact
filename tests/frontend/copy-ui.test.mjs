// =========================================================
// public/index.html のコピー機能テスト
//
//   実際の inline script を vm へ読み込み、
//   copySlot() / copyCurrentDay() / copyAll() を直接呼ぶ。
//   navigator.clipboard は記録用スタブへ差し替える。
//   実際のクリップボードへは書き込まない。
//
//   主眼は「書き込みが失敗したときに黙らないこと」。
//   失敗を握りつぶすと、利用者からは「押しても何も起きない」に見える。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPage } from './page-harness.mjs';

const OK_FETCH = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

/** 2 日分（9/16 に 2 枠、9/17 に 1 枠）の検索結果を持つページを作る。 */
function pageWithResults() {
  const page = loadPage({ fetchImpl: OK_FETCH });
  page.run(`
    currentDailyResults = [
      { date: new Date(2036, 8, 16), dateKey: '2036-09-16', slots: [
          { start: new Date(2036, 8, 16, 10, 0), end: new Date(2036, 8, 16, 11, 30) },
          { start: new Date(2036, 8, 16, 14, 0), end: new Date(2036, 8, 16, 15, 0) } ] },
      { date: new Date(2036, 8, 17), dateKey: '2036-09-17', slots: [
          { start: new Date(2036, 8, 17, 9, 0), end: new Date(2036, 8, 17, 9, 45) } ] }
    ];
    currentDayIndex = 0;
  `);
  return page;
}

/** 書き込み内容を記録するスタブ。behavior で成否を切り替える。 */
function stubClipboard(page, behavior = 'ok') {
  const written = [];
  if (behavior === 'missing') {
    delete page.context.navigator.clipboard;
  } else if (behavior === 'reject') {
    page.context.navigator.clipboard = {
      writeText: async () => { throw new Error('NotAllowedError'); },
    };
  } else if (behavior === 'throws') {
    page.context.navigator.clipboard = {
      writeText: () => { throw new TypeError('sync throw'); },
    };
  } else if (behavior === 'not-a-function') {
    page.context.navigator.clipboard = { writeText: undefined };
  } else {
    page.context.navigator.clipboard = {
      writeText: async (s) => { written.push(s); },
    };
  }
  return written;
}

const toastText = (page) => page.el('toast').textContent;

/** then / catch のマイクロタスクを消化する。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const FAIL_JA = 'コピーできませんでした。ブラウザのクリップボード権限をご確認ください。';

// ---------------------------------------------------------
// 成功系: コピーされる文字列と完了表示
// ---------------------------------------------------------

test('copySlot は表示中の日の、指定した枠だけをコピーする', async () => {
  const page = pageWithResults();
  const written = stubClipboard(page);

  page.call('copySlot', 1);
  await settle();

  assert.deepEqual(written, ['9月16日(火) 14:00〜15:00']);
  assert.equal(toastText(page), 'コピーしました');
});

test('copyCurrentDay は表示中の日の全枠だけをコピーする（翌日は含まない）', async () => {
  const page = pageWithResults();
  const written = stubClipboard(page);

  page.call('copyCurrentDay');
  await settle();

  assert.equal(written.length, 1);
  assert.equal(written[0], '9月16日(火) 10:00〜11:30\n9月16日(火) 14:00〜15:00');
  assert.equal(toastText(page), 'この日をコピーしました');
});

test('copyCurrentDay の対象は currentDayIndex に追従する', async () => {
  const page = pageWithResults();
  const written = stubClipboard(page);
  page.run('currentDayIndex = 1;');

  page.call('copyCurrentDay');
  await settle();

  assert.deepEqual(written, ['9月17日(水) 09:00〜09:45']);
});

test('copyAll は全日分をコピーする', async () => {
  const page = pageWithResults();
  const written = stubClipboard(page);

  page.call('copyAll');
  await settle();

  assert.equal(written.length, 1);
  assert.equal(
    written[0],
    '9月16日(火) 10:00〜11:30\n9月16日(火) 14:00〜15:00\n9月17日(水) 09:00〜09:45',
  );
  assert.equal(toastText(page), '全件コピーしました');
});

test('copyAll は日別結果が無くても currentSlots から復元してコピーする', async () => {
  const page = loadPage({ fetchImpl: OK_FETCH });
  const written = stubClipboard(page);
  page.run(`
    currentDailyResults = [];
    currentSlots = [ { start: new Date(2036, 8, 18, 8, 0), end: new Date(2036, 8, 18, 8, 30) } ];
  `);

  page.call('copyAll');
  await settle();

  assert.deepEqual(written, ['9月18日(木) 08:00〜08:30']);
});

test('コピー本文の改行は LF のみ（CRLF を混ぜない）', async () => {
  const page = pageWithResults();
  const written = stubClipboard(page);

  page.call('copyCurrentDay');
  await settle();

  assert.ok(written[0].includes('\n'));
  assert.ok(!written[0].includes('\r'));
});

// ---------------------------------------------------------
// 空データ: クリップボードを触らない
// ---------------------------------------------------------

test('空データではクリップボードを呼ばない', async () => {
  const page = loadPage({ fetchImpl: OK_FETCH });
  const written = stubClipboard(page);
  page.run('currentDailyResults = []; currentSlots = [];');

  page.call('copyAll');
  page.call('copyCurrentDay');
  page.call('copySlot', 0);
  await settle();

  assert.deepEqual(written, []);
});

test('存在しない枠を指すコピーはクリップボードを呼ばない', async () => {
  const page = pageWithResults();
  const written = stubClipboard(page);

  page.call('copySlot', 99);
  await settle();

  assert.deepEqual(written, []);
});

// ---------------------------------------------------------
// 失敗系: 黙って何も起きない状態を作らない
// ---------------------------------------------------------

test('writeText が reject しても unhandled rejection にせず失敗を知らせる', async () => {
  const page = pageWithResults();
  stubClipboard(page, 'reject');

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.doesNotThrow(() => page.call('copySlot', 0));
    await settle();
    await settle();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.deepEqual(unhandled, []);
  assert.equal(toastText(page), FAIL_JA);
});

test('navigator.clipboard が無い環境でも throw せず失敗を知らせる', async () => {
  const page = pageWithResults();
  stubClipboard(page, 'missing');

  assert.doesNotThrow(() => page.call('copySlot', 0));
  await settle();

  assert.equal(toastText(page), FAIL_JA);
});

test('writeText が関数でない環境でも throw せず失敗を知らせる', async () => {
  const page = pageWithResults();
  stubClipboard(page, 'not-a-function');

  assert.doesNotThrow(() => page.call('copyCurrentDay'));
  await settle();

  assert.equal(toastText(page), FAIL_JA);
});

test('writeText が同期的に throw しても外へ漏らさず失敗を知らせる', async () => {
  const page = pageWithResults();
  stubClipboard(page, 'throws');

  assert.doesNotThrow(() => page.call('copyAll'));
  await settle();
  await settle();

  assert.equal(toastText(page), FAIL_JA);
});

test('copyCurrentDay / copyAll も失敗時に同じ案内を出す', async () => {
  for (const fn of ['copyCurrentDay', 'copyAll']) {
    const page = pageWithResults();
    stubClipboard(page, 'reject');

    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      assert.doesNotThrow(() => page.call(fn));
      await settle();
      await settle();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    assert.deepEqual(unhandled, [], `${fn} が unhandled rejection を起こした`);
    assert.equal(toastText(page), FAIL_JA, `${fn} の失敗案内`);
  }
});

test('失敗しても成功時の完了表示は出さない', async () => {
  const page = pageWithResults();
  stubClipboard(page, 'reject');

  page.call('copyCurrentDay');
  await settle();
  await settle();

  assert.notEqual(toastText(page), 'この日をコピーしました');
});

// ---------------------------------------------------------
// 文言
// ---------------------------------------------------------

test('失敗案内は ja / en とも用意されている', () => {
  const page = loadPage({ fetchImpl: OK_FETCH });

  page.run("currentLang = 'ja';");
  assert.equal(page.call('t', 'copyFailed'), FAIL_JA);

  page.run("currentLang = 'en';");
  const en = page.call('t', 'copyFailed');
  assert.equal(typeof en, 'string');
  assert.ok(en.length > 0);
  assert.ok(!/[ぁ-んァ-ン一-龠]/.test(en), '英語の文言に日本語が混ざっている');
});

test('英語表示でも失敗時に英語の案内を出す', async () => {
  const page = pageWithResults();
  stubClipboard(page, 'reject');
  page.run("currentLang = 'en';");

  page.call('copySlot', 0);
  await settle();
  await settle();

  assert.equal(toastText(page), page.call('t', 'copyFailed'));
  assert.notEqual(toastText(page), FAIL_JA);
});

// ---------------------------------------------------------
// 実装の作り（回帰防止）
// ---------------------------------------------------------

test('コピー3関数は writeToClipboard 経由で書き込む（生の writeText を直接呼ばない）', async () => {
  const page = loadPage({ fetchImpl: OK_FETCH });
  assert.equal(typeof page.context.writeToClipboard, 'function');

  for (const fn of ['copySlot', 'copyCurrentDay', 'copyAll']) {
    const src = String(page.context[fn]);
    assert.ok(
      src.includes('writeToClipboard('),
      `${fn} が writeToClipboard を使っていない`,
    );
    assert.ok(
      !src.includes('navigator.clipboard'),
      `${fn} が navigator.clipboard を直接触っている`,
    );
  }
});
