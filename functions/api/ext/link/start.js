// =========================================================
// GET /api/ext/link/start — 拡張連携の確認ページ
//
//   拡張の chrome.identity.launchWebAuthFlow がこの URL を開く。
//   ここは API ではなく**ユーザーに見せるページ**であり、HTML を返す。
//
//   なぜページを挟むのか（設計の要）:
//     セッションを発行する POST は「このページから」送られる。
//     したがって Origin は https://sukimacalendar.com になり、
//     **既存の checkOrigin がそのまま通る**（allowlist を広げる必要がない）。
//     さらに「ユーザーがボタンを押す」ことが必須になるため、
//     受動的な CSRF でセッションが発行されることもない。
//     自動送信は絶対にしないこと。
//
//   設計上の約束:
//     - リダイレクト先はクエリから受け取らない。
//       許可済みの拡張機能 ID から**サーバー側で組み立てる**
//       （オープンリダイレクト＝トークン漏洩の防止）。
//     - state は形式を検証してから埋め込む。
//     - トークンは URL のフラグメント（#）で渡す。
//       クエリだと Referer やアクセスログに載り得る。
//     - inline script は nonce 付き CSP で許可する。外部リソースは読み込まない。
//
//   クエリ:  ext_id … 拡張機能 ID（EXTENSION_IDS に含まれること）
//           state  … 拡張が生成した nonce（[A-Za-z0-9_-]{8,128}）
// =========================================================

import { SESSION_RESULT, requireSession } from '../../_lib/session.js';
import { EXTENSION_ID_RE, isAllowedExtensionId } from '../../_lib/ext-cors.js';

const TAG = 'ext-link-start';

/** state の形式。拡張が生成する不透明な nonce。 */
export const STATE_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** launchWebAuthFlow が横取りするリダイレクト先のホスト。 */
export const REDIRECT_HOST_SUFFIX = '.chromiumapp.org';

/** リダイレクト先のパス。拡張側の getRedirectURL('link') と一致させること。 */
export const REDIRECT_PATH = '/link';

/**
 * 許可済みの拡張機能 ID からリダイレクト先を組み立てる。
 * クエリの値をそのまま使わないことが重要。
 *
 * @param {string} extensionId 検証済みの拡張機能 ID
 * @returns {string}
 */
export function buildRedirectUri(extensionId) {
  return 'https://' + extensionId + REDIRECT_HOST_SUFFIX + REDIRECT_PATH;
}

/**
 * JS のリテラルとして安全に埋め込める JSON 文字列にする。
 * HTML パーサに拾われる文字と行区切り文字をエスケープする。
 */
function toScriptLiteral(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** CSP 用の nonce（base64）。 */
function makeNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function htmlResponse(status, nonce, body) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; "
        + `style-src 'nonce-${nonce}'; `
        + `script-src 'nonce-${nonce}'; `
        + "connect-src 'self'; form-action 'none'; base-uri 'none'",
    },
  });
}

/** 共通のスタイル。外部 CSS は読み込まない。 */
function styleBlock(nonce) {
  return `<style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body { margin: 0; padding: 32px 20px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
           line-height: 1.7; color: #1a1a2e; background: #f7f8fa; }
    main { max-width: 420px; margin: 0 auto; background: #fff; border-radius: 12px;
           padding: 28px 24px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    h1 { font-size: 18px; margin: 0 0 12px; }
    p { font-size: 14px; margin: 0 0 16px; color: #3c4043; }
    button { width: 100%; padding: 12px 16px; font-size: 15px; font-weight: 600;
             color: #fff; background: #1a73e8; border: 0; border-radius: 8px; cursor: pointer; }
    button[disabled] { opacity: .6; cursor: default; }
    .msg { font-size: 13px; margin-top: 14px; min-height: 1.4em; }
    .err { color: #c5221f; }
    a { color: #1a73e8; }
  </style>`;
}

/** エラー・未ログインなど、ボタンを出さないページ。 */
function noticePage(status, state, heading, message, extraHtml = '') {
  const nonce = makeNonce();
  return htmlResponse(status, nonce, `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>スキマ 拡張機能の連携</title>${styleBlock(nonce)}</head>
<body data-state="${state}">
  <main>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${extraHtml}
  </main>
</body>
</html>`);
}

export async function handleLinkStart(request, env, deps = {}) {
  const { logger = console, session = requireSession } = deps;

  if (request.method !== 'GET') {
    return noticePage(405, 'method_not_allowed', '利用できません',
      'このページは GET でのみ開けます。');
  }

  const url = new URL(request.url);
  const extensionId = url.searchParams.get('ext_id') ?? '';
  const stateParam = url.searchParams.get('state') ?? '';

  // 1. 拡張機能 ID。allowlist に無いものは受け付けない。
  if (!EXTENSION_ID_RE.test(extensionId) || !isAllowedExtensionId(extensionId, env)) {
    logger.warn('[' + TAG + '] 許可されていない拡張機能 ID です。');
    return noticePage(400, 'invalid_extension', '連携できません',
      'この拡張機能は連携を許可されていません。');
  }

  // 2. state。形式を検証してからでなければ埋め込まない。
  if (!STATE_RE.test(stateParam)) {
    logger.warn('[' + TAG + '] state の形式が不正です。');
    return noticePage(400, 'invalid_state', '連携できません',
      'リクエストの形式が正しくありません。拡張機能からやり直してください。');
  }

  // 3. Web のログイン状態を確認する
  const result = await session(request, env, deps);

  if (result?.status === SESSION_RESULT.UNAVAILABLE
      || result?.status === SESSION_RESULT.MISCONFIGURED
      || result?.status === SESSION_RESULT.DATA_ERROR) {
    logger.error('[' + TAG + '] セッションを確認できません:', result.reason);
    return noticePage(503, 'unavailable', 'いま混み合っています',
      '時間をおいてもう一度お試しください。');
  }

  if (result?.status !== SESSION_RESULT.VALID) {
    return noticePage(200, 'needs_login', 'Sukima にログインしてください',
      '拡張機能と連携するには、先に Web 版 Sukima へログインする必要があります。',
      '<p><a href="https://sukimacalendar.com/" target="_blank" rel="noopener">'
      + 'sukimacalendar.com を開く</a></p>'
      + '<p>ログインしたあと、拡張機能からもう一度「連携」をお試しください。</p>');
  }

  // 4. 確認ページ。**自動送信はしない。**
  const nonce = makeNonce();
  const config = toScriptLiteral({
    extensionId,
    state: stateParam,
    redirectUri: buildRedirectUri(extensionId),
  });

  return htmlResponse(200, nonce, `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>スキマ 拡張機能の連携</title>${styleBlock(nonce)}</head>
<body data-state="ready">
  <main>
    <h1>拡張機能を連携しますか？</h1>
    <p>Chrome 拡張機能「スキマ」を、いまログインしているアカウントに紐づけます。
       カレンダーの内容は送信されません。</p>
    <button id="linkBtn" type="button">連携する</button>
    <p class="msg" id="msg"></p>
  </main>
  <script nonce="${nonce}">
    (function () {
      var CONFIG = ${config};
      var btn = document.getElementById('linkBtn');
      var msg = document.getElementById('msg');

      btn.addEventListener('click', async function () {
        btn.disabled = true;
        msg.className = 'msg';
        msg.textContent = '連携しています…';

        try {
          var res = await fetch('/api/ext/link/issue', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ extension_id: CONFIG.extensionId })
          });

          if (!res.ok) {
            msg.className = 'msg err';
            msg.textContent = res.status === 401
              ? 'ログインが切れています。sukimacalendar.com でログインし直してください。'
              : '連携できませんでした。時間をおいてお試しください。';
            btn.disabled = false;
            return;
          }

          var data = await res.json();
          if (!data || typeof data.session_token !== 'string') {
            msg.className = 'msg err';
            msg.textContent = '連携できませんでした。時間をおいてお試しください。';
            btn.disabled = false;
            return;
          }

          msg.textContent = '連携しました。拡張機能に戻ります…';
          location.replace(
            CONFIG.redirectUri
            + '#state=' + encodeURIComponent(CONFIG.state)
            + '&token=' + encodeURIComponent(data.session_token)
            + '&expires_at=' + encodeURIComponent(data.expires_at || '')
          );
        } catch (e) {
          msg.className = 'msg err';
          msg.textContent = '通信に失敗しました。接続を確認してください。';
          btn.disabled = false;
        }
      });
    })();
  </script>
</body>
</html>`);
}

/** Cloudflare Pages Functions: GET のエントリポイント */
export async function onRequestGet(context) {
  return handleLinkStart(context.request, context.env);
}

/** GET 以外のフォールバック。405 は handleLinkStart が返す。 */
export async function onRequest(context) {
  return handleLinkStart(context.request, context.env);
}
