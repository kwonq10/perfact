// =========================================================
// PWA のアップデート案内（既存の Service Worker 更新機構の上に載る UI）
//
//   - 待機中の新しい Service Worker と、latest-version.json の新しい version の
//     両方がそろったときだけ、画面下の更新パネルを出す。
//   - 文言は固定（latest-version.json の message は使わない）。バージョン番号は出さない。
//   - 「今すぐ更新」: 連打防止・「アップデートしています…」・SKIP_WAITING →
//     controllerchange で 1 回だけ reload。reload loop を起こさない。
//   - 「あとで」: このページを開いている間だけ閉じる。永久スキップは保存しない。
//   - オフライン / 有効化できる版が無い: reload せず失敗を案内し、再試行できる。
//   - インストール案内とは同時に出さない。minimumVersion の強制更新は従来どおり。
//
//   navigator.serviceWorker・location.reload・setTimeout は模擬する。
// =========================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPage, makeFetch } from './page-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const LATEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'latest-version.json'), 'utf8'));

/**
 * Service Worker を模擬したページ。
 *   controlled: 読み込み時点で SW に制御されていたか（初回インストールと更新の区別）
 *   onLine: navigator.onLine
 */
function swPage({ controlled = true, onLine = true, lang = 'ja' } = {}) {
  const swListeners = {};
  const messages = [];
  const waitingWorker = { postMessage: (m) => messages.push(m) };
  const reg = {
    waiting: null,
    installing: null,
    addEventListener() {},
    update: async () => {},
  };
  const serviceWorker = {
    controller: controlled ? { postMessage() {} } : null,
    addEventListener: (type, fn) => { swListeners[type] = fn; },
    register: async () => reg,
  };
  const p = loadPage({ fetchImpl: makeFetch([]), navigator: { serviceWorker, onLine } });
  p.run(`
    currentLang = '${lang}';
    var __reloads = 0;
    location.reload = () => { __reloads += 1; };
    var __timers = [];
    setTimeout = (fn, ms) => { __timers.push({ fn, ms }); return __timers.length; };
  `);
  return { p, reg, waitingWorker, messages, swListeners };
}

/** 現在 1.3.0 の SW に、latest=1.4.0 と待機中の新しい SW がそろった状態にする。 */
function arrive(ctx, { current = '1.3.0', latest = '1.4.0', minimum = '1.0.0', waiting = true, message } = {}) {
  const { p, reg, waitingWorker } = ctx;
  p.context.__reg = reg;
  p.context.__waiting = waitingWorker;
  p.run(`
    swUpdateState.registration = __reg;
    swUpdateState.currentVersion = '${current}';
    latestVersionInfo = { version: '${latest}', minimumVersion: '${minimum}'${message ? `, message: ${JSON.stringify(message)}` : ''} };
  `);
  if (waiting) {
    reg.waiting = waitingWorker;
    p.run('markSwUpdateAvailable(__waiting);');
  } else {
    p.run('evaluateUpdateState();');
  }
}

const shown = (p) => p.el('updateBanner').style.display === 'block';
const reloads = (p) => p.run('__reloads');
const status = (p) => p.el('updateBannerStatus').textContent;
const flushTimers = (p) => p.run('(() => { const due = __timers.splice(0); due.forEach((x) => x.fn()); })()');

// =========================================================
// 表示の条件
// =========================================================

test('更新が無い（同じ版）ときは何も表示しない', () => {
  const ctx = swPage();
  arrive(ctx, { current: '1.4.0', latest: '1.4.0' });
  assert.equal(shown(ctx.p), false);
});

test('新しい version があっても、待機中の SW がまだ無ければ表示しない', () => {
  const ctx = swPage();
  arrive(ctx, { waiting: false });
  assert.equal(shown(ctx.p), false);
});

test('待機中の SW と新しい version がそろうと更新パネルを表示する', () => {
  const ctx = swPage();
  arrive(ctx);
  assert.equal(shown(ctx.p), true);
  assert.equal(ctx.p.run('updateUiMode'), 'normal');
});

test('日本語の固定文言（見出し・本文・ボタン）', () => {
  const ctx = swPage();
  arrive(ctx);
  const { p } = ctx;
  assert.equal(p.el('updateBannerTitle').textContent, 'アップデートがあります');
  assert.equal(p.el('updateBannerMsg').textContent, 'Sukimaの新しいバージョンを利用できます。');
  assert.equal(p.el('updateBtn').textContent, '今すぐ更新');
  assert.equal(p.el('updateLaterBtn').textContent, 'あとで');
});

test('英語の固定文言', () => {
  const ctx = swPage({ lang: 'en' });
  arrive(ctx);
  const { p } = ctx;
  assert.equal(p.el('updateBannerTitle').textContent, 'Update available');
  assert.equal(p.el('updateBannerMsg').textContent, 'A new version of Sukima is available.');
  assert.equal(p.el('updateBtn').textContent, 'Update now');
  assert.equal(p.el('updateLaterBtn').textContent, 'Later');
});

test('latest-version.json の message で本文を上書きしない', () => {
  const ctx = swPage();
  arrive(ctx, { message: '独自のお知らせ文' });
  assert.equal(ctx.p.el('updateBannerMsg').textContent, 'Sukimaの新しいバージョンを利用できます。');
});

test('バージョン番号を UI に表示しない', () => {
  const ctx = swPage();
  arrive(ctx);
  const { p } = ctx;
  for (const id of ['updateBannerTitle', 'updateBannerMsg', 'updateBannerStatus', 'updateBtn', 'updateLaterBtn', 'forceUpdateMsg']) {
    assert.doesNotMatch(p.el(id).textContent, /1\.3\.0|1\.4\.0|→/, id);
  }
  assert.doesNotMatch(HTML, /id="updateBannerVersion"|id="forceUpdateVersion"|versionArrow/);
});

// =========================================================
// 「あとで」
// =========================================================

test('「あとで」で閉じ、同じ起動中は再判定（前面に戻る等）されても再表示しない', () => {
  const ctx = swPage();
  arrive(ctx);
  ctx.p.call('dismissUpdate');
  assert.equal(shown(ctx.p), false);
  ctx.p.call('evaluateUpdateState');               // visibilitychange 後の runUpdateCheck 相当
  ctx.p.call('markSwUpdateAvailable', ctx.waitingWorker); // updatefound の再通知相当
  assert.equal(shown(ctx.p), false);
});

test('「あとで」は永久スキップを保存しない', () => {
  const ctx = swPage();
  arrive(ctx);
  ctx.p.call('dismissUpdate');
  assert.equal(ctx.p.run("localStorage.getItem('sukima_update_skipped')"), null);
  assert.equal(ctx.p.run('localStorage.length'), 0);
});

test('新しく起動し直した（新しいページ）ときは、同じ更新が待機中なら再表示する', () => {
  const first = swPage();
  arrive(first);
  first.p.call('dismissUpdate');
  const second = swPage();
  arrive(second);
  assert.equal(shown(second.p), true);
});

test('古い sukima_update_skipped が残っていても、起動時の移行で消え、案内は止まらない', () => {
  const ctx = swPage();
  ctx.p.run("localStorage.setItem('sukima_update_skipped', '1.4.0');");
  ctx.p.call('migrateLegacyUpdateSkip');
  assert.equal(ctx.p.run("localStorage.getItem('sukima_update_skipped')"), null);
  arrive(ctx);
  assert.equal(shown(ctx.p), true);
  // 起動時の初期化から移行が呼ばれている
  const i = HTML.indexOf('function initUpdateNotifications() {');
  assert.match(HTML.slice(i, HTML.indexOf('}', i)), /migrateLegacyUpdateSkip\(\);/);
});

test('移行で localStorage が使えなくても落ちない', () => {
  const ctx = swPage();
  ctx.p.run("localStorage.removeItem = () => { throw new Error('denied'); };");
  ctx.p.call('migrateLegacyUpdateSkip');
  arrive(ctx);
  assert.equal(shown(ctx.p), true);
});

// =========================================================
// 「今すぐ更新」
// =========================================================

test('今すぐ更新: 待機中の SW に SKIP_WAITING を送り、「アップデートしています…」を出してボタンを押せなくする', async () => {
  const ctx = swPage();
  arrive(ctx);
  await ctx.p.call('applyUpdate');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.messages)), [{ type: 'SKIP_WAITING' }]);
  assert.equal(status(ctx.p), 'アップデートしています…');
  assert.equal(ctx.p.el('updateBtn').disabled, true);
  assert.equal(reloads(ctx.p), 0, 'controllerchange までは reload しない');
});

test('更新中の状態表示は読み上げ対象（role=status / aria-live）で、英語にも対応する', async () => {
  assert.match(HTML, /<p class="update-status" id="updateBannerStatus" role="status" aria-live="polite"><\/p>/);
  const ctx = swPage({ lang: 'en' });
  arrive(ctx);
  await ctx.p.call('applyUpdate');
  assert.equal(status(ctx.p), 'Updating…');
});

test('二重クリックしても SKIP_WAITING は 1 回だけ', async () => {
  const ctx = swPage();
  arrive(ctx);
  await Promise.all([ctx.p.call('applyUpdate'), ctx.p.call('applyUpdate')]);
  await ctx.p.call('applyUpdate');
  assert.equal(ctx.messages.length, 1);
});

test('更新中は「あとで」で閉じない', async () => {
  const ctx = swPage();
  arrive(ctx);
  await ctx.p.call('applyUpdate');
  ctx.p.call('dismissUpdate');
  assert.equal(shown(ctx.p), true);
});

test('controllerchange が来たら reload は 1 回だけ（2 回来ても・保険のタイマーが動いても 1 回）', async () => {
  const ctx = swPage({ controlled: true });
  ctx.p.call('initServiceWorkerUpdates');
  await new Promise((r) => setImmediate(r));
  arrive(ctx);
  await ctx.p.call('applyUpdate');
  ctx.swListeners.controllerchange();
  ctx.swListeners.controllerchange();
  flushTimers(ctx.p); // 10 秒後の保険 reload
  assert.equal(reloads(ctx.p), 1);
});

test('初回インストール（読み込み時に未制御）の controllerchange では reload しない', async () => {
  const ctx = swPage({ controlled: false });
  ctx.p.call('initServiceWorkerUpdates');
  await new Promise((r) => setImmediate(r));
  ctx.swListeners.controllerchange();
  assert.equal(reloads(ctx.p), 0);
});

test('reload loop なし: 更新後の新しいページでは、待機中の SW が残っていても自動で reload せず案内だけ', () => {
  const ctx = swPage();
  arrive(ctx);
  assert.equal(shown(ctx.p), true);
  assert.equal(reloads(ctx.p), 0);
  assert.equal(ctx.messages.length, 0, 'ユーザーが押すまで SKIP_WAITING を送らない');
  assert.equal(ctx.p.run('__timers.length'), 0, '保険のタイマーも仕掛けない');
});

// =========================================================
// 失敗・オフライン
// =========================================================

test('オフラインでは reload せず失敗を案内し、もう一度押せる', async () => {
  const ctx = swPage({ onLine: false });
  arrive(ctx);
  await ctx.p.call('applyUpdate');
  assert.equal(ctx.messages.length, 0);
  assert.equal(reloads(ctx.p), 0);
  assert.equal(ctx.p.run('__timers.length'), 0);
  assert.equal(status(ctx.p), 'アップデートできませんでした。通信環境を確認して、もう一度お試しください。');
  assert.equal(ctx.p.el('updateBtn').disabled, false);
  assert.equal(ctx.p.run('updateInProgress'), false);
});

test('待機中の SW が見つからない（update しても無い）ときは reload しない', async () => {
  const ctx = swPage();
  arrive(ctx);
  ctx.p.run('swUpdateState.waiting = null;');
  ctx.reg.waiting = null;
  let updated = 0;
  ctx.reg.update = async () => { updated += 1; };
  await ctx.p.call('applyUpdate');
  assert.equal(updated, 1, '一度取り直しを試みる');
  assert.equal(reloads(ctx.p), 0);
  assert.equal(ctx.p.run('__timers.length'), 0);
  assert.equal(status(ctx.p), 'アップデートできませんでした。通信環境を確認して、もう一度お試しください。');
});

test('update() が reject しても reload せず失敗を案内する', async () => {
  const ctx = swPage();
  arrive(ctx);
  ctx.p.run('swUpdateState.waiting = null;');
  ctx.reg.waiting = null;
  ctx.reg.update = async () => { throw new Error('network'); };
  await ctx.p.call('applyUpdate');
  assert.equal(reloads(ctx.p), 0);
  assert.match(status(ctx.p), /アップデートできませんでした/);
});

test('失敗後に再試行できる（待機中の SW が用意できれば SKIP_WAITING を送る）', async () => {
  const ctx = swPage();
  arrive(ctx);
  ctx.p.run('swUpdateState.waiting = null;');
  ctx.reg.waiting = null;
  await ctx.p.call('applyUpdate');
  assert.match(status(ctx.p), /アップデートできませんでした/);
  ctx.reg.waiting = ctx.waitingWorker; // 次の確認で用意できた
  await ctx.p.call('applyUpdate');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.messages)), [{ type: 'SKIP_WAITING' }]);
  assert.equal(status(ctx.p), 'アップデートしています…');
});

test('失敗表示は英語にも対応し、エラーとして目立たせる', async () => {
  const ctx = swPage({ onLine: false, lang: 'en' });
  arrive(ctx);
  await ctx.p.call('applyUpdate');
  assert.equal(status(ctx.p), 'Could not update. Check your connection and try again.');
  assert.equal(ctx.p.el('updateBannerStatus').classList.contains('is-error'), true);
});

// =========================================================
// インストール案内・強制更新
// =========================================================

test('インストール案内と同時に表示しない（更新が来たら案内を隠し、更新中は案内を出さない）', () => {
  const ctx = swPage();
  ctx.p.run('deferredPrompt = { prompt() {}, userChoice: Promise.resolve({}) };');
  ctx.p.call('maybeShowInstallBanner');
  assert.equal(ctx.p.el('installBanner').style.display, 'block');
  arrive(ctx);
  assert.equal(shown(ctx.p), true);
  assert.equal(ctx.p.el('installBanner').style.display, 'none');
  ctx.p.call('maybeShowInstallBanner');
  assert.equal(ctx.p.el('installBanner').style.display, 'none');
});

test('minimumVersion より古い版は従来どおり強制更新（「あとで」で閉じられない）', () => {
  const ctx = swPage();
  arrive(ctx, { current: '0.9.0', minimum: '1.0.0' });
  const { p } = ctx;
  assert.equal(p.run('updateUiMode'), 'forced');
  assert.equal(p.el('forceUpdateOverlay').style.display, 'flex');
  assert.equal(shown(p), false);
  p.call('dismissUpdate');
  assert.equal(p.run('updateUiMode'), 'forced');
  assert.equal(p.el('forceUpdateBtn').textContent, '今すぐ更新');
});

// =========================================================
// マークアップ・バージョン
// =========================================================

test('更新パネルは role=region + aria-labelledby、ボタンは button 要素で 44px 以上', () => {
  assert.match(HTML, /<div id="updateBanner" role="region" aria-labelledby="updateBannerTitle">/);
  assert.match(HTML, /<button type="button" class="btn-update" id="updateBtn" onclick="applyUpdate\(\)">今すぐ更新<\/button>/);
  assert.match(HTML, /<button type="button" class="btn-later" id="updateLaterBtn" onclick="dismissUpdate\(\)">あとで<\/button>/);
  for (const sel of ['#updateBanner .btn-update {', '#updateBanner .btn-later {']) {
    const i = HTML.indexOf(sel);
    assert.match(HTML.slice(i, HTML.indexOf('}', i)), /min-height: 44px/, sel);
  }
});

test('sw.js の APP_VERSION は 1.4.0、latest-version.json は 1.4.0 / minimumVersion 1.0.0', () => {
  assert.match(SW, /^const APP_VERSION = '1\.4\.0';/m);
  assert.equal(LATEST.version, '1.4.0');
  assert.equal(LATEST.minimumVersion, '1.0.0');
});

// =========================================================
// 「あとで」のあと 30 分以上離れて戻ったら再案内（Android の PWA は同じページのまま復帰するため）
// =========================================================

const MIN = 60 * 1000;

/** 時刻を差し替えられるようにする。 */
function withClock(ctx, start = 1_000_000) {
  ctx.p.run(`var __now = ${start}; Date.now = () => __now;`);
  return {
    advance: (ms) => ctx.p.run(`__now += ${ms};`),
  };
}

/** バックグラウンドへ行って、ms 後に前面へ戻る（visibilitychange 経由）。 */
function awayFor(ctx, clock, ms) {
  ctx.p.run("document.visibilityState = 'hidden';");
  ctx.p.call('handleUpdateVisibilityChange');
  clock.advance(ms);
  ctx.p.run("document.visibilityState = 'visible';");
  ctx.p.call('handleUpdateVisibilityChange');
}

/** 「あとで」を押した直後の状態を作る。 */
function dismissedPage(opts = {}) {
  const ctx = swPage();
  const clock = withClock(ctx);
  arrive(ctx, opts);
  ctx.p.call('dismissUpdate');
  assert.equal(shown(ctx.p), false);
  return { ctx, clock };
}

test('30 分ルール: 定数で 30 分、visibilitychange / pagehide / pageshow に接続されている', () => {
  assert.match(HTML, /const UPDATE_DISMISS_REPROMPT_MS = 30 \* 60 \* 1000;/);
  assert.match(HTML, /document\.addEventListener\('visibilitychange', handleUpdateVisibilityChange\);/);
  assert.match(HTML, /window\.addEventListener\('pagehide', markUpdateHidden\);/);
  assert.match(HTML, /window\.addEventListener\('pageshow', handleUpdatePageShow\);/);
});

test('「あとで」→ 29 分後に復帰: 再表示しない（抑止を保つ）', () => {
  const { ctx, clock } = dismissedPage();
  awayFor(ctx, clock, 29 * MIN);
  assert.equal(shown(ctx.p), false);
  assert.equal(ctx.p.run('updateDismissedThisSession'), true);
});

test('「あとで」→ ちょうど 30 分後に復帰: 抑止を解除して再判定し、案内する', () => {
  const { ctx, clock } = dismissedPage();
  awayFor(ctx, clock, 30 * MIN);
  assert.equal(ctx.p.run('updateDismissedThisSession'), false);
  assert.equal(shown(ctx.p), true);
});

test('「あとで」→ 31 分後に復帰: 再表示する', () => {
  const { ctx, clock } = dismissedPage();
  awayFor(ctx, clock, 31 * MIN);
  assert.equal(shown(ctx.p), true);
});

test('短い離脱を何度繰り返しても、合計が 30 分を超えただけでは再表示しない（離れていた 1 回の長さで判定）', () => {
  const { ctx, clock } = dismissedPage();
  for (let i = 0; i < 5; i++) awayFor(ctx, clock, 10 * MIN);
  assert.equal(shown(ctx.p), false);
});

test('30 分経過していても、更新が無い（current === latest）なら表示しない', () => {
  const { ctx, clock } = dismissedPage();
  ctx.p.run("swUpdateState.currentVersion = '1.4.0';"); // 待機中だった版が有効になった
  awayFor(ctx, clock, 31 * MIN);
  assert.equal(shown(ctx.p), false);
});

test('30 分経過していても、待機中の SW が無ければ表示しない', () => {
  const { ctx, clock } = dismissedPage();
  ctx.p.run('swUpdateState.waiting = null; swUpdateState.updateAvailable = false;');
  awayFor(ctx, clock, 31 * MIN);
  assert.equal(shown(ctx.p), false);
});

test('再表示後に visibilitychange を繰り返しても、案内を重ねて出し直さない', () => {
  const { ctx, clock } = dismissedPage();
  ctx.p.run('var __shows = 0; const __origShow = showNormalUpdate; showNormalUpdate = function () { __shows += 1; return __origShow(); };');
  awayFor(ctx, clock, 31 * MIN);
  assert.equal(ctx.p.run('__shows'), 1);
  for (let i = 0; i < 3; i++) awayFor(ctx, clock, 1 * MIN);
  awayFor(ctx, clock, 40 * MIN); // 「あとで」していないので抑止解除の対象外
  assert.equal(ctx.p.run('__shows'), 1);
  assert.equal(shown(ctx.p), true);
});

test('30 分経過後の再表示でも「あとで」をもう一度使え、その後の短い復帰では出ない', () => {
  const { ctx, clock } = dismissedPage();
  awayFor(ctx, clock, 31 * MIN);
  assert.equal(shown(ctx.p), true);
  ctx.p.call('dismissUpdate');
  assert.equal(shown(ctx.p), false);
  awayFor(ctx, clock, 5 * MIN);
  assert.equal(shown(ctx.p), false);
  awayFor(ctx, clock, 30 * MIN);
  assert.equal(shown(ctx.p), true);
});

test('BFCache からの復元（pageshow persisted）でも 30 分ルールを使う。通常の pageshow では何もしない', () => {
  const { ctx, clock } = dismissedPage();
  ctx.p.call('markUpdateHidden');           // pagehide
  clock.advance(10 * MIN);
  ctx.p.call('handleUpdatePageShow', { persisted: true });
  assert.equal(shown(ctx.p), false, '10 分では出さない');
  ctx.p.call('markUpdateHidden');
  clock.advance(31 * MIN);
  ctx.p.call('handleUpdatePageShow', { persisted: false });
  assert.equal(shown(ctx.p), false, '通常の読み込みの pageshow では判定しない');
  ctx.p.call('handleUpdatePageShow', { persisted: true });
  assert.equal(shown(ctx.p), true);
});

test('強制更新には 30 分ルールを適用しない（従来どおり最優先・閉じられない）', () => {
  const ctx = swPage();
  const clock = withClock(ctx);
  arrive(ctx, { current: '0.9.0', minimum: '1.0.0' });
  assert.equal(ctx.p.run('updateUiMode'), 'forced');
  ctx.p.call('dismissUpdate');
  assert.equal(ctx.p.run('updateDismissedThisSession'), false, '強制更新では「あとで」自体が効かない');
  awayFor(ctx, clock, 5 * MIN);
  assert.equal(ctx.p.run('updateUiMode'), 'forced');
  assert.equal(ctx.p.el('forceUpdateOverlay').style.display, 'flex');
});

test('完全終了後に新しい SW が有効化済み（current === latest、待機なし）なら何も表示しない', () => {
  const ctx = swPage();
  arrive(ctx, { current: '1.4.0', latest: '1.4.0', waiting: false });
  assert.equal(shown(ctx.p), false);
  assert.equal(ctx.p.run('updateUiMode'), 'none');
  assert.equal(ctx.p.el('toast').textContent, '', '通知も出さない');
});

test('「更新しました」のような新しい通知は追加していない', () => {
  assert.doesNotMatch(HTML, /更新しました|アップデートしました|Updated to|has been updated/);
});
