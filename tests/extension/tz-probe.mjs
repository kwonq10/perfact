// =========================================================
// タイムゾーン検証用のプローブ。
//
//   Node のタイムゾーンはプロセス起動時に決まるため、TZ を変えた検証は
//   子プロセスに分ける必要がある。このスクリプトは TZ が設定された
//   子プロセスとして起動され、次の 2 つを JSON で標準出力へ返す。
//
//     1. Calendar API へ渡す取得窓（timeMin / timeMax）
//     2. findFreeSlots() が実際に走査する計算窓（その日のローカル 9:00 と 22:00）
//
//   この 2 つが同じ瞬間を指していれば、
//   「取得した予定の範囲」と「空きを計算する範囲」が一致している。
//
//   使い方: node tz-probe.mjs <YYYY-MM-DD> <YYYY-MM-DD>
// =========================================================

import { loadExtension, evaluate } from "./extension-harness.mjs";

const [startText, endText] = process.argv.slice(2);
if (!startText || !endText) {
  process.stderr.write("usage: node tz-probe.mjs <start> <end>\n");
  process.exit(2);
}

const requests = [];

// Calendar API 呼び出しだけを記録し、常に空の結果を返す。
async function fetchImpl(url) {
  requests.push(String(url));
  return {
    ok: true,
    status: 200,
    async json() {
      return { items: [] };
    },
  };
}

const loaded = loadExtension({ locale: "en", fetchImpl, authToken: "test-token" });

// 検索を実行させ、fetchEvents に渡った timeMin / timeMax を取り出す。
const expression = `
  (async () => {
    customStartDateInput.value = ${JSON.stringify(startText)};
    customEndDateInput.value = ${JSON.stringify(endText)};
    accessToken = "test-token";
    calendarList = [{ id: "primary", accessRole: "owner", summary: "primary" }];
    await handleSearch();

    const start = parseLocalDateString(${JSON.stringify(startText)});
    const end = parseLocalDateString(${JSON.stringify(endText)});

    return {
      timeMin: toLocalMidnightRfc3339(start),
      timeMax: toLocalMidnightRfc3339(addDays(end, 1)),
      // findFreeSlots() が走査する計算窓（ローカル時刻）
      dayStartMs: new Date(
        start.getFullYear(), start.getMonth(), start.getDate(), DAY_START, 0, 0
      ).getTime(),
      dayEndMs: new Date(
        end.getFullYear(), end.getMonth(), end.getDate(), DAY_END, 0, 0
      ).getTime(),
      offsetMinutes: -start.getTimezoneOffset(),
    };
  })()
`;

const result = await evaluate(loaded, expression);

process.stdout.write(
  JSON.stringify(
    {
      tz: process.env.TZ || null,
      ...result,
      // 取得窓を絶対時刻（ミリ秒）へ直したもの
      timeMinMs: Date.parse(result.timeMin),
      timeMaxMs: Date.parse(result.timeMax),
      requests,
    },
    null,
    2,
  ),
);
