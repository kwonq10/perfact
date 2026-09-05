// =========================================================
// Calendar API の取得窓が、利用者のローカル日と一致することの検証。
//
//   1.1.0 まで timeMin / timeMax は "T00:00:00+09:00" と JST 固定だった。
//   一方 findFreeSlots() は new Date(y, m, d, 9, 0, 0) のように
//   ブラウザのローカル時刻で空きを計算する。
//   日本国内では両者が一致するため問題が表面化しないが、
//   JST 以外では「予定を取得する範囲」と「空きを計算する範囲」がずれ、
//   取得されなかった時間帯が空きとして表示されていた。
//
//   Node のタイムゾーンはプロセス起動時に決まるため、
//   TZ を変えた子プロセス（tz-probe.mjs）を起動して検証する。
// =========================================================

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, "tz-probe.mjs");

function probe(timeZone, startText, endText) {
  const stdout = execFileSync(process.execPath, [PROBE, startText, endText], {
    env: { ...process.env, TZ: timeZone },
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

// 検証に使うタイムゾーン。
//   Asia/Tokyo      : 既存ユーザー。回帰が無いことを確認する
//   America/New_York: JST から最も離れる側（夏時間あり）
//   Europe/London   : UTC 付近（夏時間あり）
//   Australia/Sydney: JST より東（南半球の夏時間）
//   Asia/Kolkata    : 30分単位のオフセット
const ZONES = [
  "Asia/Tokyo",
  "America/New_York",
  "Europe/London",
  "Australia/Sydney",
  "Asia/Kolkata",
];

test("子プロセスで TZ が実際に切り替わっている（検証の前提）", () => {
  const tokyo = probe("Asia/Tokyo", "2026-09-05", "2026-09-05");
  const newYork = probe("America/New_York", "2026-09-05", "2026-09-05");

  assert.equal(tokyo.offsetMinutes, 540);
  assert.equal(newYork.offsetMinutes, -240);
  assert.notEqual(tokyo.timeMin, newYork.timeMin);
});

test("日本では取得窓が従来と同じ +09:00 のまま（既存ユーザーに回帰がない）", () => {
  const result = probe("Asia/Tokyo", "2026-09-05", "2026-09-12");

  assert.equal(result.timeMin, "2026-09-05T00:00:00+09:00");
  assert.equal(result.timeMax, "2026-09-13T00:00:00+09:00");
});

test("日本の冬（夏時間なし）でも +09:00 のまま", () => {
  const result = probe("Asia/Tokyo", "2026-01-15", "2026-01-15");

  assert.equal(result.timeMin, "2026-01-15T00:00:00+09:00");
  assert.equal(result.timeMax, "2026-01-16T00:00:00+09:00");
});

test("取得窓に +09:00 が焼き込まれていない（JST 以外では別のオフセットになる）", () => {
  for (const timeZone of ZONES.filter((zone) => zone !== "Asia/Tokyo")) {
    const result = probe(timeZone, "2026-09-05", "2026-09-05");
    assert.ok(
      !result.timeMin.endsWith("+09:00"),
      `${timeZone}: timeMin が JST 固定のまま (${result.timeMin})`,
    );
    assert.ok(
      !result.timeMax.endsWith("+09:00"),
      `${timeZone}: timeMax が JST 固定のまま (${result.timeMax})`,
    );
  }
});

test("取得窓のオフセットが、そのタイムゾーンの実際のオフセットと一致する", () => {
  for (const timeZone of ZONES) {
    const result = probe(timeZone, "2026-09-05", "2026-09-05");
    const sign = result.offsetMinutes < 0 ? "-" : "+";
    const absolute = Math.abs(result.offsetMinutes);
    const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
    const minutes = String(absolute % 60).padStart(2, "0");

    assert.ok(
      result.timeMin.endsWith(`${sign}${hours}:${minutes}`),
      `${timeZone}: timeMin=${result.timeMin} offsetMinutes=${result.offsetMinutes}`,
    );
  }
});

test("どのタイムゾーンでも、計算窓が取得窓の内側に完全に収まる", () => {
  for (const timeZone of ZONES) {
    const result = probe(timeZone, "2026-09-05", "2026-09-12");

    assert.ok(
      result.timeMinMs <= result.dayStartMs,
      `${timeZone}: 取得開始(${result.timeMin}) が計算開始より後にある`,
    );
    assert.ok(
      result.dayEndMs <= result.timeMaxMs,
      `${timeZone}: 取得終了(${result.timeMax}) が計算終了より前にある`,
    );
  }
});

test("夏時間の切り替えを跨ぐ期間でも、計算窓が取得窓に収まる", () => {
  // 米国は 2026-03-08、欧州は 2026-03-29 に夏時間へ入る。
  const cases = [
    ["America/New_York", "2026-03-06", "2026-03-10"],
    ["Europe/London", "2026-03-27", "2026-03-31"],
    // 南半球は逆方向（夏時間から標準時へ戻る）。
    ["Australia/Sydney", "2026-04-03", "2026-04-07"],
  ];

  for (const [timeZone, startText, endText] of cases) {
    const result = probe(timeZone, startText, endText);
    assert.ok(
      result.timeMinMs <= result.dayStartMs,
      `${timeZone} ${startText}: 取得開始が計算開始より後にある`,
    );
    assert.ok(
      result.dayEndMs <= result.timeMaxMs,
      `${timeZone} ${endText}: 取得終了が計算終了より前にある`,
    );
  }
});

test("30分単位のオフセットも正しく表現される", () => {
  const result = probe("Asia/Kolkata", "2026-09-05", "2026-09-05");

  assert.equal(result.offsetMinutes, 330);
  assert.equal(result.timeMin, "2026-09-05T00:00:00+05:30");
  assert.equal(result.timeMax, "2026-09-06T00:00:00+05:30");
});

test("修正前の JST 固定なら、日本以外で計算窓が取得窓からはみ出していた", () => {
  // 回帰テストの土台として、旧実装の欠陥そのものを再現して示す。
  const result = probe("America/New_York", "2026-09-05", "2026-09-05");

  const legacyTimeMax = Date.parse("2026-09-06T00:00:00+09:00");
  assert.ok(
    legacyTimeMax < result.dayEndMs,
    "旧実装の取得窓が計算窓を覆えていたことになる。前提が変わっていないか確認すること",
  );

  // 現在の実装では覆えている。
  assert.ok(result.dayEndMs <= result.timeMaxMs);
});

test("Calendar API へ実際に渡された URL にも +09:00 が入っていない", () => {
  const result = probe("America/New_York", "2026-09-05", "2026-09-05");
  const eventRequests = result.requests.filter((url) => url.includes("/events?"));

  assert.ok(eventRequests.length > 0, "events リクエストが記録されていない");
  for (const url of eventRequests) {
    assert.ok(!url.includes("%2B09%3A00"), `URL に JST 固定が残っている: ${url}`);
    assert.ok(url.includes("-04%3A00"), `URL にローカルオフセットが入っていない: ${url}`);
  }
});
