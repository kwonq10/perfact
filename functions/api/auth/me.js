// =========================================================
// GET /api/auth/me — 現在のログイン状態と subscription を返す
//
//   Cloudflare Pages Functions（ファイルパス = ルート）。
//   functions/api/auth/me.js → /api/auth/me
//
//   ブラウザが持つ __Host-sukima_session Cookie だけで判定する。
//   Google ID Token も Calendar access token も受け取らない。
//
//   設計上の約束:
//     - セッション検証は _lib/session.js に一任する。
//       Cookie の解析も検証ロジックもここには書かない。
//     - 返すのは authenticated / plan_id / status と billing 情報
//       （price_phase / amount / tax_behavior を含む）
//       （entitlement / current_period_end / cancel_at_period_end /
//        currency / grace_until）。
//       user_id / google_sub / email / token / token_hash / 有効期限は返さない。
//       Stripe の内部 ID（customer / subscription / price）と
//       last_stripe_event_at / past_due_since の生値も返さない。
//     - plan_id / status は既存 client 互換のため top-level を維持する。
//       billing は追加 field で、既存 field を削除・rename しない。
//     - plan_id / status は毎回 DB の subscriptions から読まれる
//       （get_session_context が JOIN する）ため、Stripe webhook による
//       プラン変更が次のリクエストで即反映される。
//     - 有効期限の authority は DB。ここで 30日 / 90日を再計算しない。
//       RPC が返した idle_expires_at をそのまま Cookie の実効期限に使う。
//     - sliding 更新では新しい session token を発行しない。
//       Cookie の値は据え置き、Max-Age だけを延ばす。
//     - DB 異常・Supabase 障害を 401 に丸めない（フェイルクローズ）。
//
//   必要な環境変数（context.env から読む）:
//     SUPABASE_URL
//     SUPABASE_SERVICE_ROLE_KEY  クライアントへは絶対に渡さない
//
//   リクエスト:  GET  Cookie: __Host-sukima_session=<opaque token>
//   レスポンス:  200 { authenticated: true, plan_id, status, entitlement,
//                      current_period_end, cancel_at_period_end, currency,
//                      grace_until } + Set-Cookie（延長）
//               401 { authenticated: false }                  + Set-Cookie（削除）
//               405 { error: 'method_not_allowed' }
//               500 { error: 'server_misconfigured' | 'internal_error' }
//               502 { error: 'database_unavailable' }
// =========================================================

import {
  SESSION_RESULT,
  buildClearSessionCookie,
  buildSessionCookie,
  parseSessionCookie,
  requireSession,
} from '../_lib/session.js';
import {
  GRACE_STATUS,
  PAST_DUE_GRACE_MS,
  hasExtensionEntitlement,
  hasWebEntitlement,
  toTimestampMs,
} from '../_lib/entitlement.js';
import { resolveDisplayAmount } from '../_lib/billing-config.js';

/** 契約通貨として認めるもの。DB の CHECK と同じ集合（表示用の最終防衛線）。 */
const ALLOWED_CURRENCIES = Object.freeze(['jpy', 'usd']);

/**
 * DB 由来の日時を ISO 8601（UTC）へそろえる。
 * 解釈できない値は null。ここで日時を再計算はしない（形式をそろえるだけ）。
 */
function toIsoOrNull(value) {
  const ms = toTimestampMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * 表示用の猶予期限。
 *
 *   status === 'past_due' かつ past_due_since が読めるときだけ
 *   past_due_since + 7日 を返す。それ以外は null。
 *
 * 7日の定数は entitlement.js から import する。ここで別の 7日を持たない
 * （権限の正は entitlement core、ここは表示用の派生値にすぎない）。
 *
 * 猶予が既に切れていても past_due の間は返す。UI が
 * 「猶予終了済み」を表示できるようにするため。
 * grace_until が未来かどうかと entitlement の真偽は独立に扱う。
 */
export function graceUntilFrom(context) {
  if (context?.status !== GRACE_STATUS) return null;
  const since = toTimestampMs(context.past_due_since);
  if (since === null) return null;
  return new Date(since + PAST_DUE_GRACE_MS).toISOString();
}

/**
 * /api/auth/me が返す billing 部分を組み立てる。
 *
 * 返さないもの: Stripe customer / subscription / price の ID、
 * last_stripe_event_at、past_due_since の生値、user_id / email / google_sub、
 * session の有効期限。
 *
 * **表示用に返すもの**: `price_phase` と `amount`。
 *   契約概要（現在の月額）を client にハードコードさせないため、
 *   金額は **server が billing-config から引いて**配る。
 *   `amount` は表示専用で、**請求額の正は Stripe の Price**。
 *   引けない組み合わせでは `amount: null` にし、**推測で金額を作らない**。
 */
/**
 * launch 契約者の「次フェーズ（standard）の金額」。
 * launch 以外、または引けない組み合わせでは null。
 */
function nextPhaseAmountFrom(context, currency, phase) {
  if (phase !== 'launch' || currency === null) return null;
  const next = resolveDisplayAmount(context?.plan_id, currency, 'standard');
  return next === null ? null : next.amount;
}

export function buildBillingPayload(context, now) {
  const currency = ALLOWED_CURRENCIES.includes(context?.currency) ? context.currency : null;
  const phase = typeof context?.price_phase === 'string' ? context.price_phase : null;

  // 金額は「いま契約している plan / currency / phase」から引く。
  // Pro でない・情報が欠けている場合は null（画面は金額を出さない）。
  const display = (currency !== null && phase !== null)
    ? resolveDisplayAmount(context?.plan_id, currency, phase)
    : null;

  return {
    entitlement: {
      // now は 1 リクエスト内で 1 つに固定する。省略時は entitlement 側が
      // サーバー現在時刻を使う（本番はこの経路）。
      web: hasWebEntitlement(context, now),
      extension: hasExtensionEntitlement(context, now),
    },
    current_period_end: toIsoOrNull(context?.current_period_end),
    cancel_at_period_end: context?.cancel_at_period_end === true,
    currency,
    price_phase: phase,
    amount: display === null ? null : display.amount,
    tax_behavior: display === null ? null : display.tax_behavior,
    // launch 契約者に「更新後はいくらになるか」を出すための値（表示専用）。
    // **client に将来価格をハードコードさせない**ため server が配る。
    // launch 以外・引けない場合は null。
    next_phase_amount: nextPhaseAmountFrom(context, currency, phase),
    grace_until: graceUntilFrom(context),
  };
}

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      // Cookie の有無で内容が変わるため、共有キャッシュに混ぜさせない
      Vary: 'Cookie',
      ...extraHeaders,
    },
  });
}

/** 未認証。Cookie を削除して 401 を返す（Cookie が無くても削除指示を返す）。 */
function unauthenticated() {
  return json(401, { authenticated: false }, { 'Set-Cookie': buildClearSessionCookie() });
}

/**
 * ログイン状態の照会本体。
 * テストから直接呼べるよう、request / env / 差し替え可能な依存を引数で受ける。
 */
export async function handleMe(request, env, deps = {}) {
  const { session = requireSession, logger = console, now } = deps;

  if (request.method !== 'GET') {
    return json(405, { error: 'method_not_allowed' });
  }

  const result = await session(request, env, deps);

  switch (result?.status) {
    case SESSION_RESULT.VALID:
      break;

    case SESSION_RESULT.UNAUTHENTICATED:
      // Cookie なし / 形式不正 / DB に無い / 期限切れ。すべて同じ応答にする。
      return unauthenticated();

    case SESSION_RESULT.DATA_ERROR:
      // セッションは引けたが subscriptions が欠落等。401 に丸めない。
      // 「未認証だから」という理由で Cookie を削除しない。
      logger.error('[auth-me] セッションのデータ異常:', result.reason);
      return json(500, { error: 'internal_error' });

    case SESSION_RESULT.MISCONFIGURED:
      logger.error('[auth-me] 設定エラー:', result.reason);
      return json(500, { error: 'server_misconfigured' });

    case SESSION_RESULT.UNAVAILABLE:
      // Supabase へ到達できない / エラー応答。セッションの有効性は不明なので
      // Cookie は触らず、クライアントには「今は使えない」とだけ伝える。
      logger.error('[auth-me] Supabase エラー:', result.reason);
      return json(502, { error: 'database_unavailable' });

    default:
      logger.error('[auth-me] 想定外のセッション結果です。');
      return json(500, { error: 'internal_error' });
  }

  const context = result.context;
  if (!context || typeof context.plan_id !== 'string' || typeof context.status !== 'string') {
    logger.error('[auth-me] セッション context が想定と異なります。');
    return json(500, { error: 'internal_error' });
  }

  // --- sliding 更新 ---
  //   requireSession は raw token を返さないため、同じ request から
  //   既存 helper で取り出す（Cookie 解析をここで再実装しない）。
  //   新しい token は発行せず、値は据え置きのまま Max-Age だけ延ばす。
  const rawToken = parseSessionCookie(request);
  if (rawToken === null) {
    // VALID なら Cookie は必ず存在する。ここへ来るのは想定外。
    logger.error('[auth-me] 有効セッションなのに Cookie を取り出せませんでした。');
    return json(500, { error: 'internal_error' });
  }

  let cookie;
  try {
    cookie = buildSessionCookie(rawToken, context.idle_expires_at, now ? { now } : {});
  } catch {
    // idle_expires_at が日時として不正。DB 異常なので 401 に丸めない。
    logger.error('[auth-me] Cookie を組み立てられませんでした。');
    return json(500, { error: 'internal_error' });
  }

  // user_id / google_sub / email / token / token_hash / 有効期限は返さない。
  // plan_id / status は既存 client 互換のため top-level のまま据え置き、
  // billing 情報は追加 field として足す（breaking change にしない）。
  return json(
    200,
    {
      authenticated: true,
      plan_id: context.plan_id,
      status: context.status,
      ...buildBillingPayload(context, now),
    },
    { 'Set-Cookie': cookie },
  );
}

/** Cloudflare Pages Functions: GET のエントリポイント */
export async function onRequestGet(context) {
  return handleMe(context.request, context.env);
}

/**
 * Cloudflare Pages Functions: GET 以外のフォールバック。
 * メソッド別ハンドラ（onRequestGet）が優先されるため、ここへ来るのは GET 以外。
 * 念のため handleMe 側でもメソッドを検査している。
 */
export async function onRequest(context) {
  return handleMe(context.request, context.env);
}
