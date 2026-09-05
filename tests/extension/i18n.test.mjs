// =========================================================
// 多言語化（chrome.i18n / _locales）の検証。
//
//   実ファイル（chrome-extension/ 配下）だけを根拠にする。
//   ここで守りたいのは次の 4 つ。
//     1. ja / en のキー集合が完全に一致すること
//     2. メッセージが参照する placeholder がその言語で定義されていること
//     3. コード側が使うキーが messages.json に実在すること
//     4. 日本語表示が従来のままで、英語表示がキー名のまま出ないこと
// =========================================================

import test from "node:test";
import assert from "node:assert/strict";

import {
  EXTENSION_DIR,
  readExtensionFile,
  readMessages,
  createI18n,
  loadExtension,
  evaluate,
} from "./extension-harness.mjs";

const JAPANESE = /[぀-ゟ゠-ヿ一-鿿]/;

const ja = readMessages("ja");
const en = readMessages("en");

// ---------------------------------------------------------
// messages.json そのもの
// ---------------------------------------------------------

test("messages.json は ja / en とも JSON として読める", () => {
  assert.ok(Object.keys(ja).length > 0);
  assert.ok(Object.keys(en).length > 0);
});

test("ja と en のキー集合が完全に一致する", () => {
  const jaKeys = Object.keys(ja).sort();
  const enKeys = Object.keys(en).sort();

  const onlyJa = jaKeys.filter((key) => !(key in en));
  const onlyEn = enKeys.filter((key) => !(key in ja));

  assert.deepEqual(onlyJa, [], `ja にしか無いキー: ${onlyJa.join(", ")}`);
  assert.deepEqual(onlyEn, [], `en にしか無いキー: ${onlyEn.join(", ")}`);
  assert.equal(jaKeys.length, enKeys.length);
});

test("すべてのメッセージが空でない message を持つ", () => {
  for (const [locale, messages] of [["ja", ja], ["en", en]]) {
    for (const [key, entry] of Object.entries(messages)) {
      assert.equal(typeof entry.message, "string", `${locale}/${key} の message が文字列でない`);
      assert.notEqual(entry.message.trim(), "", `${locale}/${key} の message が空`);
    }
  }
});

test("メッセージ本文が参照する placeholder は、その言語で定義されている", () => {
  for (const [locale, messages] of [["ja", ja], ["en", en]]) {
    for (const [key, entry] of Object.entries(messages)) {
      const referenced = [...entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) =>
        m[1].toLowerCase(),
      );
      if (referenced.length === 0) {
        continue;
      }
      const defined = Object.keys(entry.placeholders || {}).map((name) => name.toLowerCase());
      for (const name of referenced) {
        assert.ok(
          defined.includes(name),
          `${locale}/${key}: $${name.toUpperCase()}$ が placeholders に無い`,
        );
      }
    }
  }
});

test("placeholder の content は $1..$9 の形式である", () => {
  for (const [locale, messages] of [["ja", ja], ["en", en]]) {
    for (const [key, entry] of Object.entries(messages)) {
      for (const [name, definition] of Object.entries(entry.placeholders || {})) {
        assert.match(
          definition.content,
          /^\$[1-9]$/,
          `${locale}/${key}/${name}: content が ${definition.content}`,
        );
      }
    }
  }
});

test("英語のメッセージに日本語が混ざっていない", () => {
  for (const [key, entry] of Object.entries(en)) {
    assert.ok(!JAPANESE.test(entry.message), `en/${key} に日本語が残っている: ${entry.message}`);
  }
});

test("曜日は7件、月名は12件", () => {
  for (const [locale, messages] of [["ja", ja], ["en", en]]) {
    assert.equal(messages.weekdaysShort.message.split(",").length, 7, `${locale}/weekdaysShort`);
    assert.equal(messages.monthsShort.message.split(",").length, 12, `${locale}/monthsShort`);
  }
});

test("slotCount は両言語で件数の差し込み位置 %%VALUE%% を持つ", () => {
  assert.ok(ja.slotCount.message.includes("%%VALUE%%"));
  assert.ok(en.slotCount.message.includes("%%VALUE%%"));
});

// ---------------------------------------------------------
// コードとの対応
// ---------------------------------------------------------

// t("key") / t('key') の呼び出しからキーを集める。
function collectKeysFromSource(relativePath) {
  const source = readExtensionFile(relativePath);
  return [...source.matchAll(/\bt\(\s*["']([A-Za-z0-9_]+)["']/g)].map((m) => m[1]);
}

// data-i18n="key" / data-i18n-aria-label="key" を集める。
function collectKeysFromHtml() {
  const html = readExtensionFile("sidepanel.html");
  return [...html.matchAll(/data-i18n(?:-aria-label|-href)?="([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
}

test("コードが使うキーはすべて messages.json に実在する", () => {
  const used = new Set([
    ...collectKeysFromSource("sidepanel.js"),
    ...collectKeysFromSource("sukima-api.js"),
    ...collectKeysFromHtml(),
  ]);

  assert.ok(used.size > 0, "キーが1件も集まらなかった（抽出条件を疑うこと）");

  for (const key of used) {
    assert.ok(key in ja, `ja/messages.json に ${key} が無い`);
    assert.ok(key in en, `en/messages.json に ${key} が無い`);
  }
});

test("manifest の __MSG_*__ が messages.json に実在する", () => {
  const manifest = JSON.parse(readExtensionFile("manifest.json"));
  const referenced = [manifest.name, manifest.description]
    .join(" ")
    .match(/__MSG_([A-Za-z0-9_]+)__/g)
    .map((token) => token.replace(/^__MSG_|__$/g, ""));

  assert.deepEqual(referenced, ["appNameLong", "appDesc"]);
  for (const key of referenced) {
    assert.ok(key in ja, `ja/messages.json に ${key} が無い`);
    assert.ok(key in en, `en/messages.json に ${key} が無い`);
  }
});

// ---------------------------------------------------------
// 名前の二本立て（UI 用の短い名前 / manifest・Store 用の長い名前）
//
//   appName を長い名前に差し替えると、サイドパネルの <h1>（20px 太字）が
//   2〜3 行に折り返して検索 UI が下へ押し出される。
//   ここでは「短い名前が短いままであること」を値そのもので固定する。
// ---------------------------------------------------------

test("appName と appNameLong が ja / en の両方に存在する", () => {
  for (const [locale, messages] of [["ja", ja], ["en", en]]) {
    assert.ok("appName" in messages, `${locale} に appName が無い`);
    assert.ok("appNameLong" in messages, `${locale} に appNameLong が無い`);
  }
});

test("appName は短い名前のまま（Sukima / スキマ）", () => {
  assert.equal(en.appName.message, "Sukima");
  assert.equal(ja.appName.message, "スキマ");
});

test("appNameLong は検索性のある長い名前", () => {
  assert.equal(en.appNameLong.message, "Free Time Finder for Google Calendar - Sukima");
  assert.equal(ja.appNameLong.message, "スキマ - Googleカレンダー空き時間検索");
});

test("appNameLong は Chrome の name 上限 45 文字以内", () => {
  for (const [locale, messages] of [["ja", ja], ["en", en]]) {
    const length = messages.appNameLong.message.length;
    assert.ok(
      length <= 45,
      `${locale}/appNameLong が ${length} 文字（上限 45）`,
    );
  }
});

test("appName はサイドパネルの見出しに収まる短さである", () => {
  // 20px 太字。パネル幅は利用者が変えられるため、折り返さない長さに保つ。
  for (const [locale, messages] of [["ja", ja], ["en", en]]) {
    assert.ok(
      messages.appName.message.length <= 12,
      `${locale}/appName が長すぎる: ${messages.appName.message}`,
    );
  }
});

test("sidepanel.html の <title> と <h1> は短い appName を参照する", () => {
  const html = readExtensionFile("sidepanel.html");

  assert.match(html, /<title data-i18n="appName">/);
  assert.match(html, /<h1 data-i18n="appName">/);

  // 長い名前が画面に出ていないこと。
  assert.ok(
    !html.includes('data-i18n="appNameLong"'),
    "sidepanel.html が appNameLong を参照している（見出しが折り返す）",
  );
});

test("サイドパネルの見出しが両言語とも短い名前で描画される", () => {
  for (const [locale, expected] of [["ja", "スキマ"], ["en", "Sukima"]]) {
    const loaded = loadExtension({ locale });
    const heading = evaluate(
      loaded,
      'document.querySelectorAll("[data-i18n]").filter((e) => e.tagName === "H1")[0].textContent',
    );
    assert.equal(heading, expected, `${locale} の見出し`);
  }
});

test("拡張機能のソースにユーザー表示用の日本語が残っていない", () => {
  const offenders = [];

  for (const name of ["sidepanel.js", "sukima-api.js", "background.js"]) {
    const lines = readExtensionFile(name).split("\n");
    let inBlockComment = false;
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (inBlockComment) {
        if (trimmed.includes("*/")) inBlockComment = false;
        return;
      }
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlockComment = true;
        return;
      }
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;

      const code = line.replace(/\/\/.*$/, "");
      if (JAPANESE.test(code)) {
        offenders.push(`${name}:${index + 1}: ${trimmed}`);
      }
    });
  }

  for (const name of ["sidepanel.html", "manifest.json"]) {
    readExtensionFile(name)
      .split("\n")
      .forEach((line, index) => {
        if (JAPANESE.test(line)) {
          offenders.push(`${name}:${index + 1}: ${line.trim()}`);
        }
      });
  }

  assert.deepEqual(offenders, [], `日本語が残っている:\n${offenders.join("\n")}`);
});

// ---------------------------------------------------------
// 実際の描画（VM / DOM ハーネス）
// ---------------------------------------------------------

test("日本語ロケールでの静的文言が従来どおり描画される", () => {
  const loaded = loadExtension({ locale: "ja" });
  const text = (id) => evaluate(loaded, `document.getElementById(${JSON.stringify(id)}).textContent`);

  assert.equal(text("loginBtn"), "Googleでログイン");
  assert.equal(text("authHeading"), "ログイン");
  assert.equal(text("switchAccountBtn"), "アカウントを切り替える");
  assert.equal(text("logoutBtn"), "ログアウト");
  assert.equal(text("copyAllBtn"), "この日の空き枠を一括コピー");
  assert.equal(text("presetTodayBtn"), "今日");
  assert.equal(text("presetNextMonthBtn"), "来月");
  assert.equal(text("todayBadge"), "今日");
});

test("英語ロケールでの静的文言が英語で描画される", () => {
  const loaded = loadExtension({ locale: "en" });
  const text = (id) => evaluate(loaded, `document.getElementById(${JSON.stringify(id)}).textContent`);

  assert.equal(text("loginBtn"), "Sign in with Google");
  assert.equal(text("authHeading"), "Sign in");
  assert.equal(text("switchAccountBtn"), "Switch account");
  assert.equal(text("logoutBtn"), "Sign out");
  assert.equal(text("copyAllBtn"), "Copy all slots for this day");
  assert.equal(text("presetTodayBtn"), "Today");
  assert.equal(text("presetNextMonthBtn"), "Next month");
});

test("aria-label が両言語で置き換わる", () => {
  const jaLoaded = loadExtension({ locale: "ja" });
  const enLoaded = loadExtension({ locale: "en" });

  const labels = (loaded) =>
    evaluate(
      loaded,
      'JSON.stringify(document.querySelectorAll("[data-i18n-aria-label]").map((e) => e.getAttribute("aria-label")))',
    );

  assert.deepEqual(JSON.parse(labels(jaLoaded)), [
    "アカウント",
    "検索期間",
    "期間プリセット",
    "表示日の移動",
    "空き時間",
  ]);
  assert.deepEqual(JSON.parse(labels(enLoaded)), [
    "Account",
    "Search range",
    "Date range presets",
    "Change displayed day",
    "Free time slots",
  ]);
});

test("プライバシーポリシーのリンク先が言語ごとに切り替わる", () => {
  const href = (locale) =>
    evaluate(
      loadExtension({ locale }),
      'document.querySelectorAll("[data-i18n-href]")[0].getAttribute("href")',
    );

  assert.equal(href("ja"), "https://sukimacalendar.com/extension/privacy");
  assert.equal(href("en"), "https://sukimacalendar.com/extension/privacy/en");
});

test("日付の書式が言語ごとに正しい語順になる", () => {
  const jaLoaded = loadExtension({ locale: "ja" });
  const enLoaded = loadExtension({ locale: "en" });
  const call = (loaded, key) =>
    evaluate(loaded, `t(${JSON.stringify(key)}, dateSubstitutions(new Date(2026, 8, 5)))`);

  // 2026-09-05 は土曜日。
  assert.equal(call(jaLoaded, "dateHeader"), "9/5（土）");
  assert.equal(call(jaLoaded, "dateShort"), "9月5日(土)");
  assert.equal(call(jaLoaded, "dateFull"), "2026年9月5日（土）");

  assert.equal(call(enLoaded, "dateHeader"), "9/5 (Sat)");
  assert.equal(call(enLoaded, "dateShort"), "Sep 5 (Sat)");
  assert.equal(call(enLoaded, "dateFull"), "Sat, Sep 5, 2026");
});

test("検索条件トグルのラベルが言語ごとに組み立てられる", () => {
  const jaLoaded = loadExtension({ locale: "ja" });
  const enLoaded = loadExtension({ locale: "en" });

  const label = (loaded) =>
    evaluate(
      loaded,
      `(() => {
         customStartDateInput.value = "2026-07-24";
         customEndDateInput.value = "2026-07-31";
         updateConditionsToggleLabel();
         return conditionsToggle.textContent;
       })()`,
    );

  assert.ok(label(jaLoaded).endsWith("検索条件　7/24〜7/31"));
  assert.ok(label(enLoaded).endsWith("Search options · 7/24–7/31"));
});

test("件数表示は数値部分だけを太字の span に入れ、語順は言語ごとに変わる", () => {
  const render = (locale) =>
    evaluate(
      loadExtension({ locale }),
      `(() => {
         renderDayResultCard({
           date: new Date(2026, 8, 5),
           slots: [
             { start: new Date(2026, 8, 5, 10, 0), end: new Date(2026, 8, 5, 11, 0) },
             { start: new Date(2026, 8, 5, 14, 0), end: new Date(2026, 8, 5, 15, 0) },
           ],
         });
         const count = resultsElement.descendants().find(
           (e) => e.className === "day-result-count",
         );
         const value = count.children.find(
           (c) => typeof c !== "string" && c.className === "day-result-count-value",
         );
         return JSON.stringify({ full: count.textContent, bold: value.textContent });
       })()`,
    );

  const jaResult = JSON.parse(render("ja"));
  assert.equal(jaResult.full, "空き時間 2件");
  assert.equal(jaResult.bold, "2件");

  const enResult = JSON.parse(render("en"));
  assert.equal(enResult.full, "Free time: 2 slot(s)");
  assert.equal(enResult.bold, "2 slot(s)");
});

test("空き時間0件の表示が両言語で出る", () => {
  const render = (locale) =>
    evaluate(
      loadExtension({ locale }),
      `(() => {
         renderDayResultCard({ date: new Date(2026, 8, 5), slots: [] });
         const count = resultsElement.descendants().find(
           (e) => e.className === "day-result-count",
         );
         return count.textContent;
       })()`,
    );

  assert.equal(render("ja"), "空き時間なし");
  assert.equal(render("en"), "No availability");
});

test("コピー用テキストの書式が言語ごとに変わる", () => {
  const copy = (locale) =>
    evaluate(
      loadExtension({ locale }),
      `slotToText({
         start: new Date(2026, 8, 5, 10, 0),
         end: new Date(2026, 8, 5, 11, 30),
       })`,
    );

  assert.equal(copy("ja"), "9月5日(土) 10:00〜11:30");
  assert.equal(copy("en"), "Sep 5 (Sat) 10:00–11:30");
});

test("認証エラーと Calendar API エラーが両言語で出る", () => {
  const classify = (locale, message) =>
    evaluate(
      loadExtension({ locale }),
      `classifyAuthError(new Error(${JSON.stringify(message)}))`,
    );

  assert.equal(classify("ja", "The user did not approve access."), "ログインがキャンセルされました");
  assert.equal(classify("en", "The user did not approve access."), "Sign-in was cancelled");

  const describe = (locale) =>
    evaluate(loadExtension({ locale }), "describeRequestError(new CalendarApiError(403))");

  assert.equal(describe("ja"), "Googleカレンダーへのアクセス権限がありません");
  assert.equal(describe("en"), "You do not have permission to access Google Calendar");
});

test("chrome.i18n が無い環境ではキー名を返す（画面上で取りこぼしが分かる）", () => {
  const i18n = createI18n("ja");
  assert.equal(i18n.getMessage("no_such_key_at_all"), "");
});

test("読み込んだ拡張機能のファイルはすべて chrome-extension/ 配下から来ている", () => {
  assert.match(EXTENSION_DIR.replace(/\\/g, "/"), /\/chrome-extension$/);
});
