/* =====================================================
   Sukima 広告の効果測定（Google広告）

   読み込むページ（script の data-page で指定）:
     lp       紹介ページ（/about/）
     success  決済完了ページ（/billing/success）
     settings 広告計測の設定ページ（/privacy/ads-measurement）。タグは読み込まない

   Google のタグを読み込むのは、次を **すべて** 満たすときだけ:
     1. 本番のホスト（https の sukimacalendar.com / www.sukimacalendar.com）
     2. ブラウザの Global Privacy Control が無効
     3. 利用者が「許可する」を選んでいる
        （未選択・許可しない・設定を読めない場合は読み込まない）
     4. サーバー（/api/ads/tag-config）が「本番・日本からのアクセス」と答えた
        タグ ID はサーバーの応答からしか得ない（このファイルは ID を持たない）

   許可前に広告クリック ID（gclid など）を読んだり保存したりしない。
   許可が取り消されたら（別タブを含む）、以後の送信をやめ、同意状態を
   denied に更新し、このドメインの _gcl_* Cookie を削除する。
   読み込み済みのタグはページを閉じるか再読み込みするまでメモリに残る。

   決済完了ページでは、サーバーが「初回の有料契約」と確認できたときだけ
   コンバージョンを 1 件送る。重複の防止は transaction_id（Google 側）が基本で、
   localStorage の記録は同じ端末での再送を減らすためだけに使う。

   計測が動かなくても、ページの表示や決済・アプリの動作には影響しない。
   ===================================================== */
(function (root) {
  'use strict';

  var CONSENT_KEY = 'sukima_ads_consent';
  var CONSENT_VERSION = 1;
  var CHECKOUT_KEY = 'sukima_ads_checkout';
  var SENT_PREFIX = 'sukima_ads_sent:';

  /** 決済完了ページで session_id を保持する期間。 */
  var CHECKOUT_TTL_MS = 60 * 60 * 1000;
  /** 1 回のページ表示での再問い合わせの間隔（初回 + 6 回、合計約 50 秒）。 */
  var RETRY_DELAYS_MS = [2000, 3000, 5000, 8000, 12000, 20000];
  /** 再読み込みをまたいだ問い合わせ回数の上限。 */
  var MAX_TOTAL_ATTEMPTS = 14;
  /** gtag の event_callback を待つ上限。 */
  var EVENT_TIMEOUT_MS = 5000;

  var PROD_HOSTS = ['sukimacalendar.com', 'www.sukimacalendar.com'];
  var GTAG_SRC = 'https://www.googletagmanager.com/gtag/js?id=';
  var TAG_CONFIG_URL = '/api/ads/tag-config';
  var CONVERSION_URL = '/api/billing/conversion';
  var SETTINGS_URL = '/privacy/ads-measurement';

  var TAG_ID_PATTERN = /^AW-[0-9]{6,15}$/;
  var SEND_TO_PATTERN = /^AW-[0-9]{6,15}\/[A-Za-z0-9_-]{1,64}$/;
  var TXN_PATTERN = /^sukima_sub_[0-9a-f]{40}$/;
  var SESSION_ID_PATTERN = /^cs_(live|test)_[A-Za-z0-9]{1,250}$/;

  function create(deps) {
    var win = deps.window;
    var doc = deps.document;
    var page = deps.page;
    var now = deps.now || function () { return Date.now(); };
    var setTimer = deps.setTimeout || function (fn, ms) { return win.setTimeout(fn, ms); };
    var clearTimer = deps.clearTimeout || function (id) { win.clearTimeout(id); };

    var state = {
      active: false,
      revoked: false,
      tagId: null,
      banner: null,
      timer: null,
      sending: false
    };

    // ---------- storage ----------

    function localStore() {
      try { return win.localStorage || null; } catch (e) { return null; }
    }
    function sessionStore() {
      try { return win.sessionStorage || null; } catch (e) { return null; }
    }

    /** 'granted' | 'denied' | null（未選択）| 'unavailable'（読めない） */
    function readConsent() {
      var ls = localStore();
      if (!ls) return 'unavailable';
      var raw;
      try { raw = ls.getItem(CONSENT_KEY); } catch (e) { return 'unavailable'; }
      if (raw === null || raw === undefined) return null;
      try {
        var v = JSON.parse(raw);
        if (v && v.v === CONSENT_VERSION && (v.choice === 'granted' || v.choice === 'denied')) {
          return v.choice;
        }
      } catch (e) { /* 壊れた値は未選択として扱う */ }
      return null;
    }

    /** 保存できたかどうかを返す（読み戻して確かめる）。 */
    function writeConsent(choice) {
      var ls = localStore();
      if (!ls) return false;
      try {
        ls.setItem(CONSENT_KEY, JSON.stringify({
          v: CONSENT_VERSION,
          choice: choice,
          at: new Date(now()).toISOString()
        }));
      } catch (e) { return false; }
      return readConsent() === choice;
    }

    function readCheckout() {
      var ss = sessionStore();
      if (!ss) return null;
      var raw;
      try { raw = ss.getItem(CHECKOUT_KEY); } catch (e) { return null; }
      if (!raw) return null;
      var v = null;
      try { v = JSON.parse(raw); } catch (e) { v = null; }
      if (!v || typeof v.sid !== 'string' || !SESSION_ID_PATTERN.test(v.sid)
          || typeof v.exp !== 'number' || v.exp <= now()
          || v.exp > now() + CHECKOUT_TTL_MS
          || typeof v.attempts !== 'number' || v.attempts >= MAX_TOTAL_ATTEMPTS) {
        clearCheckout();
        return null;
      }
      return v;
    }

    function saveCheckout(v) {
      var ss = sessionStore();
      if (!ss) return;
      try { ss.setItem(CHECKOUT_KEY, JSON.stringify(v)); } catch (e) { /* 保存できなくても続ける */ }
    }

    function clearCheckout() {
      var ss = sessionStore();
      if (!ss) return;
      try { ss.removeItem(CHECKOUT_KEY); } catch (e) { /* 何もしない */ }
    }

    function hasSentMark(txn) {
      var ls = localStore();
      if (!ls) return false;
      try { return ls.getItem(SENT_PREFIX + txn) !== null; } catch (e) { return false; }
    }

    function setSentMark(txn) {
      var ls = localStore();
      if (!ls) return;
      try { ls.setItem(SENT_PREFIX + txn, String(now())); } catch (e) { /* 何もしない */ }
    }

    // ---------- 環境 ----------

    function isProdHost() {
      var loc = win.location;
      return !!loc && loc.protocol === 'https:' && PROD_HOSTS.indexOf(loc.hostname) !== -1;
    }

    function gpcEnabled() {
      try { return !!(win.navigator && win.navigator.globalPrivacyControl === true); } catch (e) { return true; }
    }

    function fetchJson(url, init) {
      return win.fetch(url, init).then(function (res) {
        return res.json().then(function (body) {
          return { status: res.status, ok: res.ok, body: body };
        }, function () {
          return { status: res.status, ok: false, body: null };
        });
      });
    }

    // ---------- Google タグ ----------

    function gtag() {
      win.dataLayer.push(arguments);
    }

    function activate() {
      if (state.active || state.revoked || !state.tagId) return;
      // 読み込む直前にもう一度確かめる（別タブで撤回された場合）。
      if (readConsent() !== 'granted' || gpcEnabled() || !isProdHost()) return;
      state.active = true;

      win.dataLayer = win.dataLayer || [];
      win.gtag = gtag;
      gtag('consent', 'default', {
        ad_storage: 'granted',
        ad_user_data: 'granted',
        ad_personalization: 'denied',
        analytics_storage: 'denied'
      });
      gtag('set', 'allow_ad_personalization_signals', false);
      gtag('js', new Date(now()));
      var config = {
        allow_ad_personalization_signals: false,
        send_page_view: page === 'lp'
      };
      if (page === 'success') {
        // 参照元は Stripe の決済ページ。ドメイン部分だけにする。
        config.page_referrer = referrerOrigin();
      }
      gtag('config', state.tagId, config);

      var s = doc.createElement('script');
      s.async = true;
      s.src = GTAG_SRC + encodeURIComponent(state.tagId);
      doc.head.appendChild(s);

      if (page === 'success') runConversion();
    }

    function referrerOrigin() {
      try {
        var r = doc.referrer;
        if (!r) return '';
        var u = new URL(r);
        return u.origin + '/';
      } catch (e) { return ''; }
    }

    /** 撤回: 以後の送信をやめ、同意を denied に更新し、_gcl_* Cookie を消す。 */
    function revoke() {
      state.revoked = true;
      if (state.timer !== null) { clearTimer(state.timer); state.timer = null; }
      if (state.active && typeof win.gtag === 'function') {
        try {
          win.gtag('consent', 'update', {
            ad_storage: 'denied',
            ad_user_data: 'denied',
            ad_personalization: 'denied'
          });
        } catch (e) { /* 何もしない */ }
      }
      deleteAdCookies();
      clearCheckout();
      hideBanner();
    }

    function deleteAdCookies() {
      var raw = '';
      try { raw = doc.cookie || ''; } catch (e) { return; }
      var host = (win.location && win.location.hostname) || '';
      var domains = ['', host, '.' + host];
      var bare = host.replace(/^www\./, '');
      if (bare !== host) domains.push(bare, '.' + bare);
      raw.split(';').forEach(function (part) {
        var name = part.split('=')[0].trim();
        if (name.indexOf('_gcl_') !== 0) return;
        domains.forEach(function (d) {
          try {
            doc.cookie = name + '=; Max-Age=0; path=/' + (d ? '; domain=' + d : '');
          } catch (e) { /* 何もしない */ }
        });
      });
    }

    // ---------- コンバージョン ----------

    function runConversion() {
      var entry = readCheckout();
      if (!entry) return;
      var round = 0;

      function next() {
        if (state.revoked) return;
        if (round >= RETRY_DELAYS_MS.length) return; // このページでは打ち切る（再読み込みで再開できる）
        state.timer = setTimer(function () { state.timer = null; attempt(); }, RETRY_DELAYS_MS[round]);
        round += 1;
      }

      function attempt() {
        if (state.revoked) return;
        var current = readCheckout();
        if (!current) return;
        current.attempts += 1;
        saveCheckout(current);

        fetchJson(CONVERSION_URL, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: current.sid })
        }).then(function (r) {
          if (state.revoked) return;
          if (r.ok && r.body && r.body.state === 'eligible') {
            sendConversion(r.body);
            return;
          }
          if (r.ok && r.body && r.body.state === 'pending') { next(); return; }
          if (r.ok || (r.status >= 400 && r.status < 500)) {
            // 対象外・無効・入力不正・未ログインは再試行しない。
            clearCheckout();
            return;
          }
          next(); // 5xx
        }, function () {
          next(); // 通信失敗
        });
      }

      attempt();
    }

    function sendConversion(r) {
      if (!(typeof r.send_to === 'string' && SEND_TO_PATTERN.test(r.send_to)
            && typeof r.transaction_id === 'string' && TXN_PATTERN.test(r.transaction_id)
            && typeof r.value === 'number' && r.value > 0 && Math.floor(r.value) === r.value
            && r.currency === 'JPY')) {
        clearCheckout();
        return;
      }
      if (state.revoked || readConsent() !== 'granted') { clearCheckout(); return; }
      if (hasSentMark(r.transaction_id)) { clearCheckout(); return; }
      if (state.sending) return;
      state.sending = true;

      var done = false;
      gtag('event', 'conversion', {
        send_to: r.send_to,
        value: r.value,
        currency: 'JPY',
        transaction_id: r.transaction_id,
        event_timeout: EVENT_TIMEOUT_MS,
        event_callback: function () {
          if (done) return;
          done = true;
          // Google が受信した証明ではない。同じ端末での再送を減らすためだけの記録。
          setSentMark(r.transaction_id);
          clearCheckout();
        }
      });
    }

    // ---------- 同意の案内 ----------

    var BANNER_CSS = [
      '#sukima-ads-consent{position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;',
      'max-width:560px;margin:0 auto;background:#fff;color:#1a1a2e;border:1px solid #d6dbe4;',
      'border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.18);padding:16px 18px;',
      'font:14px/1.7 "Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif}',
      '#sukima-ads-consent h2{font-size:15px;margin:0 0 6px;font-weight:700}',
      '#sukima-ads-consent p{margin:0 0 12px}',
      '#sukima-ads-consent a{color:#2f6fd6}',
      '#sukima-ads-consent .sukima-ads-actions{display:flex;gap:10px}',
      '#sukima-ads-consent .sukima-ads-choice{flex:1 1 0;min-height:44px;padding:10px 12px;',
      'border:1px solid #4f5b70;border-radius:10px;background:#fff;color:#1a1a2e;',
      'font:inherit;font-weight:700;cursor:pointer}',
      '#sukima-ads-consent .sukima-ads-choice:focus-visible{outline:3px solid #1a4fa0;outline-offset:2px}'
    ].join('');

    function showBanner() {
      if (state.banner || !doc.body) return;
      var style = doc.createElement('style');
      style.textContent = BANNER_CSS;
      doc.head.appendChild(style);

      var box = doc.createElement('section');
      box.id = 'sukima-ads-consent';
      box.setAttribute('role', 'region');
      box.setAttribute('aria-label', '広告の効果測定の設定');

      var h = doc.createElement('h2');
      h.textContent = '広告の効果測定について';
      box.appendChild(h);

      var p = doc.createElement('p');
      p.appendChild(doc.createTextNode(
        'Google広告の効果を測るため、このページでGoogleのタグを読み込んでもよいですか。'
        + '許可した場合だけ読み込み、Cookieが保存されることがあります。'
        + '許可しなくても、スキマの利用やお支払いには影響しません。設定はあとから変更できます。'));
      var more = doc.createElement('a');
      more.href = SETTINGS_URL;
      more.textContent = '詳しく';
      p.appendChild(doc.createTextNode(' '));
      p.appendChild(more);
      box.appendChild(p);

      var actions = doc.createElement('div');
      actions.className = 'sukima-ads-actions';
      // 2 つのボタンは同じ見た目・同じ大きさにする（どちらかを目立たせない）。
      var grant = makeChoice('許可する', 'granted');
      var deny = makeChoice('許可しない', 'denied');
      actions.appendChild(grant);
      actions.appendChild(deny);
      box.appendChild(actions);

      doc.body.appendChild(box);
      state.banner = box;
    }

    function makeChoice(label, choice) {
      var b = doc.createElement('button');
      b.type = 'button';
      b.className = 'sukima-ads-choice';
      b.setAttribute('data-choice', choice);
      b.textContent = label;
      b.addEventListener('click', function () { choose(choice); });
      return b;
    }

    function choose(choice) {
      var saved = writeConsent(choice);
      hideBanner();
      if (choice === 'granted' && saved) {
        state.revoked = false;
        activate();
      } else {
        clearCheckout();
      }
    }

    function hideBanner() {
      if (state.banner && state.banner.parentNode) state.banner.parentNode.removeChild(state.banner);
      state.banner = null;
    }

    // ---------- 別タブでの変更 ----------

    function onStorage(e) {
      if (!e || e.key !== CONSENT_KEY && e.key !== null) return;
      var c = readConsent();
      if (page === 'settings') { renderSettings(); return; }
      if (c === 'granted') {
        if (!state.active && state.tagId && !gpcEnabled()) {
          hideBanner();
          state.revoked = false;
          activate();
        }
        return;
      }
      if (c === 'denied' || c === 'unavailable' || state.active) {
        revoke();
      }
    }

    // ---------- 設定ページ ----------

    function renderSettings() {
      var status = doc.getElementById('adsConsentStatus');
      var gpcNote = doc.getElementById('adsGpcNote');
      var storageNote = doc.getElementById('adsStorageNote');
      var c = readConsent();
      if (status) {
        status.textContent = c === 'granted' ? '現在の設定: 許可しています'
          : c === 'denied' ? '現在の設定: 許可していません'
          : c === 'unavailable' ? '現在の設定: このブラウザでは設定を保存できません（Googleのタグは読み込みません）'
          : '現在の設定: まだ選択していません（Googleのタグは読み込みません）';
      }
      if (gpcNote) gpcNote.hidden = !gpcEnabled();
      if (storageNote) storageNote.hidden = c !== 'unavailable';
    }

    function bindSettings() {
      var grant = doc.getElementById('adsGrant');
      var deny = doc.getElementById('adsDeny');
      if (grant) grant.addEventListener('click', function () { writeConsent('granted'); renderSettings(); });
      if (deny) {
        deny.addEventListener('click', function () {
          writeConsent('denied');
          deleteAdCookies();
          renderSettings();
        });
      }
      renderSettings();
    }

    // ---------- 開始 ----------

    function start() {
      win.addEventListener('storage', onStorage);

      if (page === 'settings') { bindSettings(); return Promise.resolve(); }
      if (page !== 'lp' && page !== 'success') return Promise.resolve();

      if (!isProdHost() || gpcEnabled()) { clearCheckout(); return Promise.resolve(); }
      var consent = readConsent();
      if (consent === 'denied' || consent === 'unavailable') { clearCheckout(); return Promise.resolve(); }

      return fetchJson(TAG_CONFIG_URL, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store'
      }).then(function (r) {
        if (!r.ok || !r.body || r.body.enabled !== true
            || typeof r.body.tag_id !== 'string' || !TAG_ID_PATTERN.test(r.body.tag_id)) {
          clearCheckout();
          return;
        }
        state.tagId = r.body.tag_id;
        var c = readConsent();
        if (c === 'granted') { activate(); return; }
        if (c === null) { showBanner(); return; }
        clearCheckout();
      }, function () {
        clearCheckout();
      });
    }

    return {
      start: start,
      // テスト用に内部状態を見せる（本番の動作には使わない）
      _state: state,
      _readConsent: readConsent
    };
  }

  root.SukimaAdsMeasurement = { create: create };

  if (root.__SUKIMA_ADS_NO_AUTOSTART__ === true) return;
  try {
    var current = root.document && root.document.currentScript;
    var pageName = current ? current.getAttribute('data-page') : null;
    create({ window: root, document: root.document, page: pageName }).start();
  } catch (e) {
    /* 計測が動かなくてもページの動作は止めない */
  }
})(typeof window !== 'undefined' ? window : this);
