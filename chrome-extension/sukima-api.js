// =========================================================
// Sukima API クライアント（Chrome 拡張サイドパネル用）
//
//   sidepanel.js より先に読み込むこと。グローバルに window.SukimaApi を作る。
//
//   設計上の約束:
//     - manifest を変更せずに動くこと。
//         * 通信は host_permissions ではなく **サーバー側 CORS** に依存する
//           （/api/ext/* だけが chrome-extension:// を許可している）
//         * 連携は既存の "identity" 権限だけで済む launchWebAuthFlow を使う
//         * 保存は "storage" 権限が要らない localStorage を使う
//     - Google のアクセストークンはこのモジュールでは一切扱わない。
//       Calendar API 用のトークンと Sukima のセッションは完全に別物。
//     - セッショントークン・user_id をログへ出さない。
//     - quota を消費するのは「明示的な検索」だけ。自動処理では呼ばない。
// =========================================================

(function (global) {
  'use strict';

  /** 本番の canonical host。www は使わない（apex へ 308 されるため）。 */
  var SUKIMA_ORIGIN = 'https://sukimacalendar.com';

  var LINK_START_URL = SUKIMA_ORIGIN + '/api/ext/link/start';
  var RESERVE_URL = SUKIMA_ORIGIN + '/api/ext/quota/reserve';
  var COMMIT_URL = SUKIMA_ORIGIN + '/api/ext/quota/commit';
  var RELEASE_URL = SUKIMA_ORIGIN + '/api/ext/quota/release';
  var LOGOUT_URL = SUKIMA_ORIGIN + '/api/ext/auth/logout';

  /** localStorage のキー。値はセッショントークンと有効期限のみ。 */
  var STORAGE_KEY = 'sukima_ext_session_v1';

  /** launchWebAuthFlow のリダイレクト先パス。サーバー側 REDIRECT_PATH と一致させる。 */
  var REDIRECT_PATH = 'link';

  /**
   * quota を有効にするかどうか。
   *
   * **本番では false のまま出荷する。**
   * extension_pro の販売・解除導線が完成するまで、既存ユーザーを
   * 「無制限 → 週3回」へ変更しない（製品方針 #1）。
   *
   * 有効化するときは、この定数ではなくサーバー側のフラグで切り替えられる
   * ようにしてから行うこと。拡張の再申請なしに戻せるようにするため。
   */
  var QUOTA_ENABLED = false;

  // ------------------------------------------------------------------
  // セッションの保存（localStorage。storage 権限は不要）
  // ------------------------------------------------------------------

  function loadSession() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.token !== 'string' || parsed.token.length === 0) {
        return null;
      }
      // 期限切れならローカルでも捨てる（権威はサーバー側）。
      if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= Date.now()) {
        clearSession();
        return null;
      }
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function saveSession(token, expiresAt) {
    try {
      global.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ token: token, expiresAt: expiresAt || null })
      );
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearSession() {
    try {
      global.localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      // 消せなくても呼び出し側の流れは止めない
    }
  }

  function isLinked() {
    return loadSession() !== null;
  }

  // ------------------------------------------------------------------
  // 連携（launchWebAuthFlow）
  // ------------------------------------------------------------------

  /** state 用の不透明な nonce。サーバー側 STATE_RE と同じ文字種にする。 */
  function newState() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i += 1) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  /** 検索試行ごとの冪等キー。Web 版 index.html と同じ方針。 */
  function newIdempotencyKey() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    var hex = '';
    for (var i = 0; i < bytes.length; i += 1) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return 'k-' + hex;
  }

  function launchWebAuthFlow(url) {
    return new Promise(function (resolve, reject) {
      chrome.identity.launchWebAuthFlow({ url: url, interactive: true }, function (redirectUrl) {
        if (chrome.runtime.lastError) {
          reject(new Error('link_flow_failed'));
          return;
        }
        if (!redirectUrl) {
          reject(new Error('link_cancelled'));
          return;
        }
        resolve(redirectUrl);
      });
    });
  }

  /**
   * Web のログイン済みセッションから拡張用セッションを受け取る。
   *
   * @returns {Promise<{ok:boolean, code?:string}>}
   */
  async function link() {
    var state = newState();
    var redirectUri = chrome.identity.getRedirectURL(REDIRECT_PATH);
    var url = LINK_START_URL
      + '?ext_id=' + encodeURIComponent(chrome.runtime.id)
      + '&state=' + encodeURIComponent(state);

    var redirectUrl;
    try {
      redirectUrl = await launchWebAuthFlow(url);
    } catch (e) {
      return { ok: false, code: e && e.message === 'link_cancelled' ? 'cancelled' : 'failed' };
    }

    // リダイレクト先が自分宛てであることを確認する。
    if (typeof redirectUrl !== 'string' || redirectUrl.indexOf(redirectUri) !== 0) {
      return { ok: false, code: 'unexpected_redirect' };
    }

    var hashIndex = redirectUrl.indexOf('#');
    if (hashIndex === -1) return { ok: false, code: 'no_token' };

    var params = new URLSearchParams(redirectUrl.slice(hashIndex + 1));
    if (params.get('state') !== state) {
      return { ok: false, code: 'state_mismatch' };
    }

    var token = params.get('token');
    if (!token) return { ok: false, code: 'no_token' };

    if (!saveSession(token, params.get('expires_at'))) {
      return { ok: false, code: 'storage_failed' };
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // quota API
  // ------------------------------------------------------------------

  /**
   * Bearer 認証の POST。
   *
   * credentials は明示的に 'omit'。この経路は Cookie を使わない。
   *
   * @returns {Promise<{httpOk:boolean, status:number, data:object|null}>}
   */
  async function postWithBearer(url, payload) {
    var session = loadSession();
    if (session === null) {
      return { httpOk: false, status: 0, data: null, notLinked: true };
    }

    var res = await fetch(url, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + session.token
      },
      body: JSON.stringify(payload || {})
    });

    if (res.status === 401) {
      // サーバー側で失効している。ローカルの保存も捨てて再連携へ誘導する。
      clearSession();
    }

    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    return { httpOk: res.ok, status: res.status, data: data };
  }

  /**
   * 明示的な検索の直前に 1 回分を予約する。
   *
   * 未連携なら連携フローを 1 回だけ開く（呼び出し元がユーザー操作の
   * 延長にあることが前提。launchWebAuthFlow はユーザー操作を必要とする）。
   *
   * @returns {Promise<{proceed:boolean, reservationId:string|null, message:string|null}>}
   */
  async function reserveSearch() {
    if (!QUOTA_ENABLED) {
      return { proceed: true, reservationId: null, message: null };
    }

    if (!isLinked()) {
      var linked = await link();
      if (!linked.ok) {
        return {
          proceed: false,
          reservationId: null,
          message: linked.code === 'cancelled'
            ? '連携がキャンセルされました'
            : 'Sukima との連携に失敗しました'
        };
      }
    }

    var out;
    try {
      out = await postWithBearer(RESERVE_URL, { idempotency_key: newIdempotencyKey() });
    } catch (e) {
      return { proceed: false, reservationId: null, message: '検索を開始できませんでした' };
    }

    if (out.notLinked) {
      return { proceed: false, reservationId: null, message: 'Sukima との連携が必要です' };
    }
    if (!out.httpOk) {
      if (out.status === 401) {
        return { proceed: false, reservationId: null, message: '連携が切れました。もう一度お試しください' };
      }
      return { proceed: false, reservationId: null, message: '検索を開始できませんでした' };
    }

    var data = out.data;
    if (!data || typeof data !== 'object') {
      return { proceed: false, reservationId: null, message: '検索を開始できませんでした' };
    }

    // Pro（quota 免除）。reservation_id が無いので commit / release は呼ばない。
    if (data.quota_enforced === false) {
      return { proceed: true, reservationId: null, message: null };
    }

    if (data.allowed !== true) {
      return {
        proceed: false,
        reservationId: null,
        message: data.code === 'limit_reached'
          ? '今週の無料検索回数（3回）を使い切りました'
          : '検索を開始できませんでした。もう一度お試しください'
      };
    }

    return {
      proceed: true,
      reservationId: typeof data.reservation_id === 'string' ? data.reservation_id : null,
      message: null
    };
  }

  /** 検索成功時の確定。best effort（失敗しても検索結果は捨てない）。 */
  async function commit(reservationId) {
    if (!reservationId) return;
    try {
      await postWithBearer(COMMIT_URL, { reservation_id: reservationId });
    } catch (e) {
      // best effort
    }
  }

  /** 検索失敗時の返却。best effort（失敗しても元のエラー表示を変えない）。 */
  async function release(reservationId) {
    if (!reservationId) return;
    try {
      await postWithBearer(RELEASE_URL, { reservation_id: reservationId });
    } catch (e) {
      // best effort
    }
  }

  /** 拡張のセッションを失効させる。Web のログイン状態には影響しない。 */
  async function logout() {
    var session = loadSession();
    clearSession();
    if (session === null) return;

    try {
      await fetch(LOGOUT_URL, {
        method: 'POST',
        credentials: 'omit',
        headers: { Authorization: 'Bearer ' + session.token }
      });
    } catch (e) {
      // ローカルは既に消しているので、通信失敗でも流れは止めない
    }
  }

  global.SukimaApi = {
    isQuotaEnabled: function () { return QUOTA_ENABLED; },
    isLinked: isLinked,
    link: link,
    reserveSearch: reserveSearch,
    commit: commit,
    release: release,
    logout: logout,
    clearSession: clearSession,
    newIdempotencyKey: newIdempotencyKey
  };
})(self);
