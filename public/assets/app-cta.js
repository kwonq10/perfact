/* =====================================================
   Sukima 共通インストールCTA
     各ページの記述は次の2行だけでよい。

       <div data-sukima-app-cta><a href="/app">Sukimaをインストール</a></div>
       <script src="/assets/app-cta.js" defer></script>

     このスクリプトが [data-sukima-app-cta] を探して中身を差し替える。
     JS が動かない環境では素の /app リンクがそのまま残る。

     PC   : QRコードを主表示（スマホで読み取ってもらう）
     スマホ: 「Sukimaをインストール」ボタンを主表示し /app へ送る
   ===================================================== */
(function () {
  'use strict';

  var APP_PATH = '/app';
  var QR_SRC = '/assets/app-qr.svg';
  var QR_ALT = 'https://sukimacalendar.com/app';
  var CSS_HREF = '/assets/app-cta.css';
  var LANG_KEY = 'sukima_lang';

  var I18N = {
    ja: {
      installApp: 'Sukimaをインストール',
      scanQr: ['スマホでQRコードを読み取って', 'Sukimaをインストール'],
      useBrowser: 'このままブラウザで使う'
    },
    en: {
      installApp: 'Install Sukima',
      scanQr: ['Scan the QR code with your phone', 'to install Sukima'],
      useBrowser: 'Continue in the browser'
    }
  };

  // 本体と同じ保存キーを尊重し、無ければブラウザの言語を見る
  function detectLang() {
    var saved = null;
    try { saved = localStorage.getItem(LANG_KEY); } catch (e) { saved = null; }
    if (saved === 'ja' || saved === 'en') return saved;
    var nav = (navigator.language || '').toLowerCase();
    return nav.indexOf('ja') === 0 ? 'ja' : 'en';
  }

  var lang = detectLang();
  function t(key) {
    var dict = I18N[lang] || I18N.ja;
    return dict[key] !== undefined ? dict[key] : I18N.ja[key];
  }

  // タッチ対応ノートPCを誤判定しないよう pointer:coarse 単独では判定しない
  function isMobile() {
    if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') {
      return navigator.userAgentData.mobile;
    }
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  }

  function ensureStylesheet() {
    var links = document.querySelectorAll('link[rel="stylesheet"]');
    for (var i = 0; i < links.length; i++) {
      if ((links[i].getAttribute('href') || '').indexOf('app-cta.css') !== -1) return;
    }
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    document.head.appendChild(link);
  }

  function buildMobile() {
    var frag = document.createDocumentFragment();
    var a = document.createElement('a');
    a.className = 'sukima-cta__btn';
    a.href = APP_PATH;
    a.textContent = t('installApp');
    frag.appendChild(a);
    return frag;
  }

  function buildDesktop() {
    var frag = document.createDocumentFragment();

    var img = document.createElement('img');
    img.className = 'sukima-cta__qr';
    img.alt = QR_ALT;
    img.width = 180;
    img.height = 180;
    // QRは3KB程度なので遅延読み込みはしない。
    // src より後に loading='lazy' を付けると読み込みが始まらないため、その回避も兼ねる。
    img.src = QR_SRC;
    frag.appendChild(img);

    var p = document.createElement('p');
    p.className = 'sukima-cta__text';
    // 固定文言だが innerHTML は使わず、改行は br 要素で組み立てる
    var lines = t('scanQr');
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) p.appendChild(document.createElement('br'));
      p.appendChild(document.createTextNode(lines[i]));
    }
    frag.appendChild(p);

    var sub = document.createElement('a');
    sub.className = 'sukima-cta__sub';
    sub.href = '/';
    sub.textContent = t('useBrowser');
    frag.appendChild(sub);

    return frag;
  }

  function render(host) {
    host.classList.add('sukima-cta');
    // data-theme はページ側の指定をそのまま活かす（暗い背景向けの配色）
    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(isMobile() ? buildMobile() : buildDesktop());
  }

  function init() {
    var hosts = document.querySelectorAll('[data-sukima-app-cta]');
    if (hosts.length === 0) return;
    ensureStylesheet();
    for (var i = 0; i < hosts.length; i++) render(hosts[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
