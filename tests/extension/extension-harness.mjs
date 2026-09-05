// =========================================================
// Chrome 拡張（chrome-extension/）を Node 上で読むためのハーネス。
//
//   sidepanel.html は分割せず読むだけにし、sidepanel.js / sukima-api.js を
//   vm コンテキストで評価する。実ブラウザではないため、DOM は
//   「このテストが必要とする範囲だけ」を再現した最小スタブである。
//
//   chrome.i18n は _locales/<locale>/messages.json を実ファイルから読み、
//   Chrome と同じ置換規則（$1.. と名前付き placeholder）を再現する。
//   そのため「翻訳の取りこぼし」と「placeholder の食い違い」を実物で検出できる。
//
//   注意: vm コンテキストは別レルムなので、戻り値の比較に deepStrictEqual は
//   使えない（tests/frontend/page-harness.mjs と同じ制約）。
// =========================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_DIR = path.resolve(HERE, "..", "..", "chrome-extension");

export function readExtensionFile(relativePath) {
  return readFileSync(path.join(EXTENSION_DIR, relativePath), "utf8");
}

export function readMessages(locale) {
  return JSON.parse(readExtensionFile(path.join("_locales", locale, "messages.json")));
}

// ---------------------------------------------------------
// chrome.i18n の再現
// ---------------------------------------------------------

// Chrome の置換規則:
//   - messages.json の placeholders は content: "$1" のように substitutions の位置を指す
//   - メッセージ本文では $NAME$ で参照する（大文字小文字は区別しない）
//   - 該当する placeholder が無い $NAME$ はそのまま残る
export function renderMessage(entry, substitutions) {
  const list = Array.isArray(substitutions)
    ? substitutions
    : substitutions === undefined
      ? []
      : [substitutions];

  const placeholders = entry.placeholders || {};
  const byLowerName = new Map();
  for (const [name, definition] of Object.entries(placeholders)) {
    byLowerName.set(name.toLowerCase(), definition.content);
  }

  return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (whole, name) => {
    const content = byLowerName.get(name.toLowerCase());
    if (content === undefined) {
      return whole;
    }
    const match = /^\$(\d+)$/.exec(content);
    if (!match) {
      return content;
    }
    const value = list[Number(match[1]) - 1];
    return value === undefined ? "" : String(value);
  });
}

export function createI18n(locale) {
  const messages = readMessages(locale);
  return {
    locale,
    messages,
    getMessage(key, substitutions) {
      const entry = messages[key];
      if (!entry) {
        return "";
      }
      return renderMessage(entry, substitutions);
    },
    getUILanguage() {
      return locale;
    },
  };
}

// ---------------------------------------------------------
// 最小 DOM スタブ
// ---------------------------------------------------------

class StubClassList {
  constructor() {
    this.set = new Set();
  }
  add(...names) {
    names.forEach((name) => this.set.add(name));
  }
  remove(...names) {
    names.forEach((name) => this.set.delete(name));
  }
  toggle(name, force) {
    const shouldHave = force === undefined ? !this.set.has(name) : Boolean(force);
    if (shouldHave) {
      this.set.add(name);
    } else {
      this.set.delete(name);
    }
    return shouldHave;
  }
  contains(name) {
    return this.set.has(name);
  }
}

class StubElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.classList = new StubClassList();
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.listeners = new Map();
    this._text = "";
    this.value = "";
    this.checked = false;
    this.type = "";
    this.className = "";
    this.title = "";
    this.htmlFor = "";
    this.id = "";
  }

  get textContent() {
    if (this.children.length === 0) {
      return this._text;
    }
    return this.children.map((child) => (typeof child === "string" ? child : child.textContent)).join("");
  }

  set textContent(value) {
    this.children = [];
    this._text = value === undefined || value === null ? "" : String(value);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  append(...nodes) {
    this._text = "";
    nodes.forEach((node) => this.children.push(node));
  }
  appendChild(node) {
    this._text = "";
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes) {
    this._text = "";
    this.children = nodes.slice();
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }
  dispatch(type, event = {}) {
    const handlers = this.listeners.get(type) || [];
    return Promise.all(handlers.map((handler) => handler(event)));
  }

  matches() {
    return false;
  }
  querySelectorAll() {
    return [];
  }

  // 子孫を含めて走査する（テストからの検証用。実装コードは使わない）。
  descendants() {
    const out = [];
    const walk = (node) => {
      node.children.forEach((child) => {
        if (typeof child !== "string") {
          out.push(child);
          walk(child);
        }
      });
    };
    walk(this);
    return out;
  }
}

// sidepanel.html から、id・data-i18n 系の属性・開始タグ直後のテキストを読み取る。
// 完全な HTML パーサではなく、この構造に必要な情報だけを取り出す。
//
//   開始タグ直後のテキストは「i18n が解決できなかったときに残る既定値」であり、
//   フォールバックの検証に必須なので必ず拾う。
function parseSidepanelHtml(html) {
  const tags = [];
  const tagPattern = /<(\w+)((?:\s+[^<>]*?)?)\/?>/g;
  let match;
  while ((match = tagPattern.exec(html)) !== null) {
    const [, tagName, rawAttributes] = match;
    const attributes = {};
    const attributePattern = /([\w-]+)(?:="([^"]*)")?/g;
    let attributeMatch;
    while ((attributeMatch = attributePattern.exec(rawAttributes)) !== null) {
      attributes[attributeMatch[1]] = attributeMatch[2] === undefined ? "" : attributeMatch[2];
    }

    // 開始タグの直後から、次のタグが始まるまでをテキストとみなす。
    const after = html.slice(match.index + match[0].length);
    const nextTag = after.indexOf("<");
    const defaultText = nextTag === -1 ? after : after.slice(0, nextTag);

    tags.push({ tagName, attributes, defaultText });
  }
  return tags;
}

export function createDocument(html) {
  const byId = new Map();
  const i18nElements = [];
  const ariaElements = [];
  const hrefElements = [];
  const all = [];

  for (const { tagName, attributes, defaultText } of parseSidepanelHtml(html)) {
    const element = new StubElement(tagName);
    // HTML に書かれた既定テキスト（i18n が解決できないときに残る値）。
    element.textContent = defaultText;
    if (attributes.id) {
      element.id = attributes.id;
      byId.set(attributes.id, element);
    }
    if (attributes.class) {
      element.className = attributes.class;
    }
    if (attributes["aria-label"] !== undefined) {
      element.setAttribute("aria-label", attributes["aria-label"]);
    }
    if (attributes.hidden !== undefined) {
      element.hidden = true;
    }
    if (attributes["data-i18n"] !== undefined) {
      element.dataset.i18n = attributes["data-i18n"];
      i18nElements.push(element);
    }
    if (attributes["data-i18n-aria-label"] !== undefined) {
      element.dataset.i18nAriaLabel = attributes["data-i18n-aria-label"];
      ariaElements.push(element);
    }
    if (attributes["data-i18n-href"] !== undefined) {
      element.dataset.i18nHref = attributes["data-i18n-href"];
      hrefElements.push(element);
    }
    if (attributes.href !== undefined) {
      element.setAttribute("href", attributes.href);
    }
    all.push(element);
  }

  const documentElement = new StubElement("html");
  documentElement.lang = "en";

  const document = {
    documentElement,
    createElement: (tagName) => new StubElement(tagName),
    createTextNode: (text) => String(text),
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll: (selector) => {
      if (selector === "[data-i18n]") return i18nElements.slice();
      if (selector === "[data-i18n-aria-label]") return ariaElements.slice();
      if (selector === "[data-i18n-href]") return hrefElements.slice();
      return [];
    },
    _byId: byId,
    _all: all,
    _i18nElements: i18nElements,
    _ariaElements: ariaElements,
    _hrefElements: hrefElements,
  };
  return document;
}

// ---------------------------------------------------------
// 拡張機能の読み込み
// ---------------------------------------------------------

/**
 * sukima-api.js と sidepanel.js を vm 上で評価する。
 *
 * @param {object} options
 * @param {string} options.locale            "ja" | "en"
 * @param {function} options.fetchImpl       グローバル fetch の差し替え
 * @param {string|null} options.authToken    null なら未ログイン状態から始まる
 * @param {object|null} options.i18n         chrome.i18n の差し替え。
 *                                           カタログ不在・破損の再現に使う。
 */
export function loadExtension(options = {}) {
  const {
    locale = "ja",
    fetchImpl = async () => {
      throw new Error("fetch was not stubbed");
    },
    authToken = null,
    i18n = null,
  } = options;

  const html = readExtensionFile("sidepanel.html");
  const document = createDocument(html);

  const identityCalls = [];
  const chrome = {
    runtime: { id: "cbiheilipajkapmejmpmhjiflgpfhglg", lastError: undefined },
    i18n: i18n || createI18n(locale),
    identity: {
      getAuthToken(details, callback) {
        identityCalls.push({ method: "getAuthToken", details });
        if (authToken === null) {
          chrome.runtime.lastError = { message: "not signed in" };
          callback(undefined);
          chrome.runtime.lastError = undefined;
          return;
        }
        callback(authToken);
      },
      removeCachedAuthToken(details, callback) {
        identityCalls.push({ method: "removeCachedAuthToken", details });
        callback();
      },
      clearAllCachedAuthTokens(callback) {
        identityCalls.push({ method: "clearAllCachedAuthTokens" });
        callback();
      },
      getRedirectURL: (suffix) => `https://cbiheilipajkapmejmpmhjiflgpfhglg.chromiumapp.org/${suffix}`,
      launchWebAuthFlow(details, callback) {
        identityCalls.push({ method: "launchWebAuthFlow", details });
        chrome.runtime.lastError = { message: "not used in tests" };
        callback(undefined);
        chrome.runtime.lastError = undefined;
      },
    },
  };

  const storage = new Map();
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };

  const sandbox = {
    document,
    chrome,
    localStorage,
    fetch: fetchImpl,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Promise,
    Number,
    String,
    Array,
    Object,
    Error,
    TypeError,
    Map,
    Set,
    WeakMap,
    URLSearchParams,
    crypto: globalThis.crypto,
    navigator: { clipboard: { writeText: async () => {} } },
    window: { open() {} },
    AbortController,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);

  // sidepanel.html と同じ順序で読み込む（sukima-api.js が先）。
  vm.runInContext(readExtensionFile("sukima-api.js"), context, { filename: "sukima-api.js" });
  vm.runInContext(readExtensionFile("sidepanel.js"), context, { filename: "sidepanel.js" });

  return { context, sandbox, document, chrome, identityCalls, storage };
}

/** vm コンテキスト内の式を評価する。 */
export function evaluate(loaded, expression) {
  return vm.runInContext(expression, loaded.context);
}
