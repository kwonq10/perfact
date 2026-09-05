// =========================================================
// i18n カタログが読めないときの安全策を固定する。
//
//   実 Chrome では、拡張機能を再読み込みするまで manifest の default_locale が
//   反映されない。その間 Chrome はメッセージカタログを持たず、
//   chrome.i18n.getMessage() は全キーで空文字を返す。
//   一方、未パッケージ拡張の sidepanel.html / sidepanel.js は
//   パネルを開くたびにディスクから読み直されるため、新しいコードだけが動く。
//
//   この「新しいコード × カタログ無し」の組み合わせで、以前は
//   loginBtn / searchBtn のようなキー名がそのまま画面に出ていた。
//   ここではその状態を再現し、キー名が二度と表に出ないことを固定する。
// =========================================================

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync } from "node:fs";

import {
  EXTENSION_DIR,
  readExtensionFile,
  readMessages,
  loadExtension,
  evaluate,
} from "./extension-harness.mjs";

/** カタログが存在しない Chrome を再現する（全キーで空文字）。 */
const EMPTY_CATALOG = {
  getMessage: () => "",
  getUILanguage: () => "en",
};

/** カタログはあるが中身が壊れている状態を再現する。 */
function brokenCatalog(overrides) {
  const messages = readMessages("en");
  return {
    getMessage(key, substitutions) {
      if (key in overrides) {
        return overrides[key];
      }
      const entry = messages[key];
      if (!entry) {
        return "";
      }
      const list = Array.isArray(substitutions) ? substitutions : [];
      return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (whole, name) => {
        const placeholder = (entry.placeholders || {})[name.toLowerCase()];
        if (!placeholder) return whole;
        const index = Number(placeholder.content.slice(1));
        return list[index - 1] === undefined ? "" : String(list[index - 1]);
      });
    },
    getUILanguage: () => "en",
  };
}

const allKeys = Object.keys(readMessages("en"));

// ---------------------------------------------------------
// カタログ不在
// ---------------------------------------------------------

test("カタログ不在でも、静的文言にキー名が出ない", () => {
  const loaded = loadExtension({ i18n: EMPTY_CATALOG });

  const rendered = JSON.parse(
    evaluate(
      loaded,
      'JSON.stringify(document.querySelectorAll("[data-i18n]").map((e) => [e.dataset.i18n, e.textContent]))',
    ),
  );

  assert.ok(rendered.length > 0, "data-i18n 要素が集まらなかった");
  const offenders = rendered.filter(([key, text]) => key === text);
  assert.deepEqual(offenders, [], `キー名が表示されている: ${JSON.stringify(offenders)}`);
});

test("カタログ不在でも、HTML の英語既定値がそのまま残る", () => {
  const loaded = loadExtension({ i18n: EMPTY_CATALOG });
  const text = (id) =>
    evaluate(loaded, `document.getElementById(${JSON.stringify(id)}).textContent`);

  assert.equal(text("loginBtn"), "Sign in with Google");
  assert.equal(text("authHeading"), "Sign in");
  assert.equal(text("switchAccountBtn"), "Switch account");
  assert.equal(text("logoutBtn"), "Sign out");
  assert.equal(text("copyAllBtn"), "Copy all slots for this day");
  assert.equal(text("presetTodayBtn"), "Today");
  assert.equal(text("presetNextMonthBtn"), "Next month");
  assert.equal(text("todayBadge"), "Today");
});

test("カタログ不在でも、aria-label にキー名が出ない", () => {
  const loaded = loadExtension({ i18n: EMPTY_CATALOG });

  const labels = JSON.parse(
    evaluate(
      loaded,
      'JSON.stringify(document.querySelectorAll("[data-i18n-aria-label]").map((e) => [e.dataset.i18nAriaLabel, e.getAttribute("aria-label")]))',
    ),
  );

  for (const [key, value] of labels) {
    assert.notEqual(value, key, `aria-label にキー名: ${key}`);
    assert.notEqual(value, "", `aria-label が空になった: ${key}`);
  }
});

test("カタログ不在でも、プライバシーポリシーのリンクが壊れない", () => {
  const loaded = loadExtension({ i18n: EMPTY_CATALOG });
  const href = evaluate(
    loaded,
    'document.querySelectorAll("[data-i18n-href]")[0].getAttribute("href")',
  );

  assert.match(href, /^https:\/\/sukimacalendar\.com\/extension\/privacy/);
  assert.notEqual(href, "privacyPolicyUrl");
});

test("カタログ不在でも、曜日が7件そろう（英語の既定値へ落ちる）", () => {
  const loaded = loadExtension({ i18n: EMPTY_CATALOG });
  const names = JSON.parse(
    evaluate(loaded, "JSON.stringify([0,1,2,3,4,5,6].map((i) => weekdayName(i)))"),
  );

  assert.deepEqual(names, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
});

test("カタログ不在でも、月名が12件そろう（英語の既定値へ落ちる）", () => {
  const loaded = loadExtension({ i18n: EMPTY_CATALOG });
  const names = JSON.parse(
    evaluate(
      loaded,
      "JSON.stringify([0,1,2,3,4,5,6,7,8,9,10,11].map((i) => monthName(i)))",
    ),
  );

  assert.deepEqual(names, [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ]);
});

test("カタログ不在でも、JS が組み立てる文言にキー名が出ない", () => {
  const loaded = loadExtension({ i18n: EMPTY_CATALOG });

  const values = JSON.parse(
    evaluate(
      loaded,
      `JSON.stringify({
         toggle: (() => {
           customStartDateInput.value = "";
           customEndDateInput.value = "";
           updateConditionsToggleLabel();
           return conditionsToggle.textContent;
         })(),
         header: (() => { renderDateHeaderText(); return displayDateElement.textContent; })(),
         timeRange: slotToTimeText({
           start: new Date(2026, 8, 5, 10, 0),
           end: new Date(2026, 8, 5, 11, 30),
         }),
         copyText: slotToText({
           start: new Date(2026, 8, 5, 10, 0),
           end: new Date(2026, 8, 5, 11, 30),
         }),
         fullDate: formatFullDateLabel(new Date(2026, 8, 5)),
         authError: classifyAuthError(new Error("The user did not approve access.")),
         apiError: describeRequestError(new CalendarApiError(403)),
         count: (() => {
           const parts = buildSlotCountParts(2);
           return parts.before + parts.value + parts.after;
         })(),
       })`,
    ),
  );

  for (const [label, value] of Object.entries(values)) {
    for (const key of allKeys) {
      assert.ok(
        !String(value).includes(key),
        `${label} にキー名 ${key} が混ざっている: ${JSON.stringify(value)}`,
      );
    }
  }
});

test("未知のキーを引いてもキー名が返らない", () => {
  const loaded = loadExtension({ locale: "en" });

  assert.equal(evaluate(loaded, 't("no_such_key_at_all")'), "");
  assert.equal(evaluate(loaded, 't("no_such_key_at_all", [], "fallback")'), "fallback");
});

// ---------------------------------------------------------
// カタログの破損
// ---------------------------------------------------------

test("曜日メッセージが欠けていれば英語の既定値へ落ちる", () => {
  for (const broken of ["Sun,Mon,Tue", "Sun,,Tue,Wed,Thu,Fri,Sat", ""]) {
    const loaded = loadExtension({ i18n: brokenCatalog({ weekdaysShort: broken }) });
    const names = JSON.parse(
      evaluate(loaded, "JSON.stringify([0,1,2,3,4,5,6].map((i) => weekdayName(i)))"),
    );
    assert.deepEqual(
      names,
      ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      `weekdaysShort=${JSON.stringify(broken)}`,
    );
  }
});

test("月名メッセージが欠けていれば英語の既定値へ落ちる", () => {
  const loaded = loadExtension({ i18n: brokenCatalog({ monthsShort: "Jan,Feb" }) });
  const names = JSON.parse(
    evaluate(
      loaded,
      "JSON.stringify([0,1,2,3,4,5,6,7,8,9,10,11].map((i) => monthName(i)))",
    ),
  );

  assert.equal(names.length, 12);
  assert.equal(names[0], "Jan");
  assert.equal(names[11], "Dec");
});

test("一部のキーだけ欠けても、他のキーは正しく解決される", () => {
  const loaded = loadExtension({ i18n: brokenCatalog({ loginBtn: "" }) });

  // 欠けたキーは HTML の既定値が残る。
  assert.equal(
    evaluate(loaded, 'document.getElementById("loginBtn").textContent'),
    "Sign in with Google",
  );
  // 欠けていないキーはカタログの値になる。
  assert.equal(
    evaluate(loaded, 'document.getElementById("presetThisWeekBtn").textContent'),
    "This week",
  );
});

// ---------------------------------------------------------
// manifest とカタログの整合
// ---------------------------------------------------------

test("manifest の default_locale に対応する messages.json が存在する", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.json"));
  const locale = manifest.default_locale;

  assert.ok(locale, "default_locale が設定されていない");

  const catalog = path.join(EXTENSION_DIR, "_locales", locale, "messages.json");
  assert.ok(
    existsSync(catalog),
    `default_locale="${locale}" だが ${catalog} が無い（Chrome が拡張機能を読み込めない）`,
  );
});

test("manifest が参照する __MSG_*__ が default_locale のカタログに存在する", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.json"));
  const catalog = readMessages(manifest.default_locale);

  const referenced = [manifest.name, manifest.description]
    .join(" ")
    .match(/__MSG_([A-Za-z0-9_]+)__/g)
    .map((token) => token.replace(/^__MSG_|__$/g, ""));

  for (const key of referenced) {
    assert.ok(key in catalog, `${manifest.default_locale} に ${key} が無い`);
    assert.notEqual(catalog[key].message.trim(), "", `${key} が空`);
  }
});

test("HTML の英語既定値が en/messages.json と一致する（フォールバックが正しい英語である保証）", () => {
  const en = readMessages("en");
  const html = readExtensionFile("sidepanel.html");

  const mismatches = [];
  for (const match of html.matchAll(/data-i18n="([A-Za-z0-9_]+)"[^>]*>([^<]*)</g)) {
    const [, key, defaultText] = match;
    if (!(key in en)) {
      mismatches.push(`${key}: messages.json に無い`);
      continue;
    }
    if (defaultText !== en[key].message) {
      mismatches.push(`${key}: HTML=${JSON.stringify(defaultText)} en=${JSON.stringify(en[key].message)}`);
    }
  }

  assert.deepEqual(mismatches, [], `HTML の既定値が英訳とずれている:\n${mismatches.join("\n")}`);
});

test("sukima-api.js の t() もキー名を返さない", () => {
  const source = readExtensionFile("sukima-api.js");

  assert.ok(!/return key;/.test(source), "sukima-api.js が key を返している");
  assert.match(source, /return '';/);
});

test("拡張機能のコードに、キー名を返すフォールバックが残っていない", () => {
  for (const name of ["sidepanel.js", "sukima-api.js"]) {
    assert.ok(
      !/return key;/.test(readExtensionFile(name)),
      `${name} に return key; が残っている`,
    );
  }
});
