/* share-qr.js — 全ページ共通 QR シェアボタン + モーダル */
(function () {
  'use strict';

  var I18N = {
    ja: {
      btnLabel: 'QRコードでシェア',
      title: 'Sukimaをシェア',
      desc: 'このQRコードをスマホで読み取ると、Sukimaをすぐに使えます',
      close: '閉じる',
    },
    en: {
      btnLabel: 'Share via QR',
      title: 'Share Sukima',
      desc: 'Scan this QR code with a smartphone to start using Sukima.',
      close: 'Close',
    },
  };

  function getLang() {
    try { return localStorage.getItem('sukima_lang') || 'ja'; } catch (e) { return 'ja'; }
  }

  function strings() {
    return I18N[getLang()] || I18N.ja;
  }

  /* ---- CSS inject ---- */
  var css = [
    '#sqr-btn{',
    '  position:fixed;top:14px;right:16px;z-index:150;',
    '  display:flex;align-items:center;justify-content:center;',
    '  width:44px;height:44px;border-radius:10px;',
    '  background:rgba(255,255,255,0.92);',
    '  border:1.5px solid rgba(0,0,0,0.12);',
    '  box-shadow:0 2px 8px rgba(0,0,0,0.10);',
    '  cursor:pointer;color:#1a1a2e;padding:0;',
    '  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);',
    '  transition:box-shadow 0.15s,transform 0.1s;',
    '}',
    '#sqr-btn:hover{background:#fff;box-shadow:0 4px 14px rgba(0,0,0,0.16);}',
    '#sqr-btn:active{transform:scale(0.94);}',
    '#sqr-overlay{',
    '  display:none;position:fixed;inset:0;z-index:250;',
    '  background:rgba(0,0,0,0.48);',
    '  align-items:center;justify-content:center;',
    '  padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right))',
    '  max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));',
    '}',
    '#sqr-overlay.sqr-open{display:flex;}',
    '#sqr-modal{',
    '  position:relative;background:#fff;border-radius:20px;',
    '  padding:28px 24px 24px;width:100%;max-width:300px;',
    '  text-align:center;',
    '  box-shadow:0 20px 50px rgba(0,0,0,0.22);',
    '}',
    '#sqr-close{',
    '  position:absolute;top:12px;right:14px;',
    '  background:none;border:none;font-size:22px;line-height:1;',
    '  cursor:pointer;color:#aaa;padding:4px 7px;border-radius:6px;',
    '  transition:color 0.12s;',
    '}',
    '#sqr-close:hover{color:#333;}',
    '#sqr-modal-title{',
    '  font-size:16px;font-weight:700;color:#1a1a2e;',
    '  margin:0 0 8px;',
    '}',
    '#sqr-modal-desc{',
    '  font-size:13px;color:#666;line-height:1.65;margin:0 0 18px;',
    '}',
    '#sqr-modal-img{',
    '  display:block;width:200px;height:200px;margin:0 auto 12px;',
    '}',
    '#sqr-modal-url{font-size:12px;color:#999;margin:0;}',
    '@media(max-width:360px){',
    '  #sqr-modal{padding:24px 14px 20px;}',
    '  #sqr-modal-img{width:180px;height:180px;}',
    '}',
  ].join('');

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  /* ---- QR icon SVG ---- */
  var ICON = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<rect x="2" y="2" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.5" fill="none"/>'
    + '<rect x="4" y="4" width="2" height="2" fill="currentColor" rx="0.3"/>'
    + '<rect x="12" y="2" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.5" fill="none"/>'
    + '<rect x="14" y="4" width="2" height="2" fill="currentColor" rx="0.3"/>'
    + '<rect x="2" y="12" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.5" fill="none"/>'
    + '<rect x="4" y="14" width="2" height="2" fill="currentColor" rx="0.3"/>'
    + '<rect x="12" y="12" width="2.4" height="2.4" fill="currentColor" rx="0.3"/>'
    + '<rect x="15.6" y="12" width="2.4" height="2.4" fill="currentColor" rx="0.3"/>'
    + '<rect x="13.8" y="13.8" width="2.4" height="2.4" fill="currentColor" rx="0.3"/>'
    + '<rect x="12" y="15.6" width="2.4" height="2.4" fill="currentColor" rx="0.3"/>'
    + '<rect x="15.6" y="15.6" width="2.4" height="2.4" fill="currentColor" rx="0.3"/>'
    + '</svg>';

  /* ---- DOM ---- */
  var btn = document.createElement('button');
  btn.id = 'sqr-btn';
  btn.type = 'button';
  btn.innerHTML = ICON;

  // index.html: langToggle が右上にあるのでボタンを左にずらす
  if (document.getElementById('langToggle')) {
    btn.style.right = '112px';
  }

  var overlay = document.createElement('div');
  overlay.id = 'sqr-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'sqr-modal-title');

  var modal = document.createElement('div');
  modal.id = 'sqr-modal';

  var closeBtn = document.createElement('button');
  closeBtn.id = 'sqr-close';
  closeBtn.type = 'button';
  closeBtn.textContent = '\u00d7'; // ×

  var titleEl = document.createElement('p');
  titleEl.id = 'sqr-modal-title';

  var descEl = document.createElement('p');
  descEl.id = 'sqr-modal-desc';

  var imgEl = document.createElement('img');
  imgEl.id = 'sqr-modal-img';
  imgEl.src = '/assets/app-qr.svg';
  imgEl.alt = 'Sukima QR code';
  imgEl.width = 200;
  imgEl.height = 200;

  var urlEl = document.createElement('p');
  urlEl.id = 'sqr-modal-url';
  urlEl.textContent = 'sukimacalendar.com/app';

  modal.appendChild(closeBtn);
  modal.appendChild(titleEl);
  modal.appendChild(descEl);
  modal.appendChild(imgEl);
  modal.appendChild(urlEl);
  overlay.appendChild(modal);

  /* ---- i18n ---- */
  function applyI18n() {
    var s = strings();
    btn.setAttribute('aria-label', s.btnLabel);
    titleEl.textContent = s.title;
    descEl.textContent = s.desc;
    closeBtn.setAttribute('aria-label', s.close);
  }

  /* ---- Modal open / close ---- */
  function openModal() {
    overlay.classList.add('sqr-open');
    document.body.style.overflow = 'hidden';
    closeBtn.focus();
  }

  function closeModal() {
    overlay.classList.remove('sqr-open');
    document.body.style.overflow = '';
    btn.focus();
  }

  /* ---- Events ---- */
  function setupEvents() {
    btn.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal();
    });
    modal.addEventListener('click', function (e) {
      e.stopPropagation();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('sqr-open')) {
        closeModal();
      }
    });
  }

  /* ---- Hook into index.html setLang (if present) ---- */
  function hookSetLang() {
    if (typeof window.setLang === 'function') {
      var orig = window.setLang;
      window.setLang = function (lang) {
        orig(lang);
        applyI18n();
      };
    }
  }

  /* ---- Init ---- */
  function init() {
    document.body.appendChild(btn);
    document.body.appendChild(overlay);
    applyI18n();
    setupEvents();
    hookSetLang();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
