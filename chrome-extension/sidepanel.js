const DAY_START = 9;
const DAY_END = 22;
const STEP_MIN = 30;

let accessToken = null;
let currentSlots = [];
let calendarList = [];
let periodResults = [];
let periodIndex = 0;

const loginBtn = document.getElementById("loginBtn");
const authView = document.getElementById("authView");
const accountSection = document.getElementById("accountSection");
const switchAccountBtn = document.getElementById("switchAccountBtn");
const logoutBtn = document.getElementById("logoutBtn");
const dayView = document.getElementById("dayView");
const displayDateElement = document.getElementById("displayDate");
const todayBadge = document.getElementById("todayBadge");
const prevDayBtn = document.getElementById("prevDayBtn");
const prevWeekBtn = document.getElementById("prevWeekBtn");
const nextDayBtn = document.getElementById("nextDayBtn");
const nextWeekBtn = document.getElementById("nextWeekBtn");
const conditionsToggle = document.getElementById("conditionsToggle");
const conditionsPanel = document.getElementById("conditionsPanel");
const searchBtn = document.getElementById("searchBtn");
const customRangeInputs = document.getElementById("customRangeInputs");
const customStartDateInput = document.getElementById("customStartDate");
const customEndDateInput = document.getElementById("customEndDate");
const presetTodayBtn = document.getElementById("presetTodayBtn");
const presetThisWeekBtn = document.getElementById("presetThisWeekBtn");
const presetNextWeekBtn = document.getElementById("presetNextWeekBtn");
const presetThisMonthBtn = document.getElementById("presetThisMonthBtn");
const presetNextMonthBtn = document.getElementById("presetNextMonthBtn");
const presetButtons = [
  presetTodayBtn,
  presetThisWeekBtn,
  presetNextWeekBtn,
  presetThisMonthBtn,
  presetNextMonthBtn,
];
const periodPositionElement = document.getElementById("periodPosition");
const periodBoundaryMessageElement = document.getElementById("periodBoundaryMessage");
const durationSelect = document.getElementById("duration");
const calendarListElement = document.getElementById("calendarList");
const allCalendarsCheckbox = document.getElementById("allCalendars");
const statusElement = document.getElementById("status");
const resultsElement = document.getElementById("results");
const copyAllBtn = document.getElementById("copyAllBtn");
const extensionToastElement = document.getElementById("extensionToast");

// 開始日〜終了日を "7/24〜7/31" 形式にする。年をまたぐ場合のみ年を表示する。
function formatDateRangeLabel(start, end) {
  const sameYear = start.getFullYear() === end.getFullYear();
  const formatOne = (date, withYear) => {
    const yearPart = withYear ? `${date.getFullYear()}/` : "";
    return `${yearPart}${date.getMonth() + 1}/${date.getDate()}`;
  };
  return `${formatOne(start, !sameYear)}〜${formatOne(end, !sameYear)}`;
}

// 折りたたみ見出しに、入力中の開始日〜終了日を添える（例: "▼ 検索条件　7/24〜7/31"）。
function updateConditionsToggleLabel() {
  const arrow = conditionsPanel.hidden ? "▼" : "▲";
  const startValue = customStartDateInput.value;
  const endValue = customEndDateInput.value;

  if (!startValue || !endValue) {
    conditionsToggle.textContent = `${arrow} 検索条件`;
    return;
  }

  const start = parseLocalDateString(startValue);
  const end = parseLocalDateString(endValue);
  conditionsToggle.textContent = `${arrow} 検索条件　${formatDateRangeLabel(start, end)}`;
}

// プリセットボタンの選択状態表示を切り替える。
function setActivePresetButton(activeId) {
  presetButtons.forEach((button) => {
    button.classList.toggle("is-active", button.id === activeId);
  });
}

function clearActivePresetButton() {
  presetButtons.forEach((button) => button.classList.remove("is-active"));
}

// プリセットの期間を開始日・終了日入力へ反映する（自動検索はしない）。
function applyPresetRange(getRange, buttonId) {
  const { start, end } = getRange();
  customStartDateInput.value = toLocalDateString(start);
  customEndDateInput.value = toLocalDateString(end);
  setActivePresetButton(buttonId);
  updateConditionsToggleLabel();
}

// 開始日・終了日入力を「今日〜7日後」の初期値へ戻す。
function resetDateInputsToDefault() {
  const today = startOfDay(new Date());
  const defaultEnd = addDays(today, 7);
  customStartDateInput.value = toLocalDateString(today);
  customEndDateInput.value = toLocalDateString(defaultEnd);
  clearActivePresetButton();
  updateConditionsToggleLabel();
}

let displayedDate = startOfDay(new Date());
let toastHideTimer = null;

// 画面下部に一時的な通知を表示する。連続呼び出し時は表示時間をリセットする。
function showToast(message) {
  extensionToastElement.textContent = message;
  extensionToastElement.classList.add("is-visible");

  if (toastHideTimer !== null) {
    clearTimeout(toastHideTimer);
  }

  toastHideTimer = setTimeout(() => {
    extensionToastElement.classList.remove("is-visible");
    toastHideTimer = null;
  }, 2000);
}

// トーストを即座に非表示にする（ログアウト等、状態リセット時に使用）。
function hideToastImmediately() {
  if (toastHideTimer !== null) {
    clearTimeout(toastHideTimer);
    toastHideTimer = null;
  }
  extensionToastElement.classList.remove("is-visible");
}

// 日付の比較に使うため、時刻部分を0時に揃える。
function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function toLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isSameDay(first, second) {
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

// "YYYY-MM-DD"をUTC解釈せず、ローカル日付として安全に生成する共通関数。
function parseLocalDateString(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day);
}

// setDate()で加算するため、月末・年末を正しく跨ぐ。
function addDays(date, days) {
  const result = startOfDay(date);
  result.setDate(result.getDate() + days);
  return result;
}

// 月曜始まりの週の月曜日を返す。
function startOfWeekMonday(date) {
  const weekday = date.getDay();
  const offsetToMonday = weekday === 0 ? -6 : 1 - weekday;
  return addDays(date, offsetToMonday);
}

function getTodayRange() {
  const today = startOfDay(new Date());
  return { start: today, end: today };
}

function getThisWeekRange() {
  const today = startOfDay(new Date());
  const start = startOfWeekMonday(today);
  const end = addDays(start, 6);
  return { start, end };
}

function getNextWeekRange() {
  const { start: thisWeekStart } = getThisWeekRange();
  const start = addDays(thisWeekStart, 7);
  const end = addDays(start, 6);
  return { start, end };
}

// 「今月」は月初ではなく、今日から今月末日までとする。
function getThisMonthRange() {
  const start = startOfDay(new Date());
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  return { start, end };
}

function getNextMonthRange() {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const end = new Date(today.getFullYear(), today.getMonth() + 2, 0);
  return { start, end };
}

// 開始日〜終了日（両端含む）の日数を数える。capを超えたら早期に打ち切る。
function daysBetweenInclusive(start, end, cap = Infinity) {
  let count = 0;
  for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) {
    count += 1;
    if (count > cap) {
      return count;
    }
  }
  return count;
}

// 日付見出しの表示のみを更新する（ナビゲーションボタンの状態は変更しない）。
// 十字ナビの中央は短縮形式（例: "8/2（日）"）。年は表示しない。
function renderDateHeaderText() {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const weekday = displayedDate.getDay();
  displayDateElement.textContent =
    `${displayedDate.getMonth() + 1}/${displayedDate.getDate()}（${weekdays[weekday]}）`;
  displayDateElement.classList.toggle("sunday", weekday === 0);
  displayDateElement.classList.toggle("saturday", weekday === 6);

  const today = startOfDay(new Date());
  const isToday = isSameDay(displayedDate, today);
  todayBadge.hidden = !isToday;
}

// 状態メッセージとエラー表示を一箇所で切り替える。
function setStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", isError);
}

// ログイン前の画面（Googleでログインボタンのみ）へ切り替える。
function showLoggedOut() {
  authView.hidden = false;
  accountSection.hidden = true;
  dayView.hidden = true;
}

// ログイン後の画面（接続表示・検索UI）へ切り替える。
function showLoggedIn() {
  authView.hidden = true;
  accountSection.hidden = false;
  dayView.hidden = false;
  renderDateHeaderText();
}

// token・カレンダー一覧・検索結果（期間検索結果を含む）をまとめて初期状態に戻す。
function resetSessionState() {
  accessToken = null;
  calendarList = [];
  currentSlots = [];
  calendarListElement.replaceChildren();
  resultsElement.replaceChildren();
  copyAllBtn.hidden = true;
  periodResults = [];
  periodIndex = 0;
  periodPositionElement.hidden = true;
  periodPositionElement.textContent = "";
  periodBoundaryMessageElement.textContent = "";
  clearWeekNavigationHint();
  clearBoundaryAriaState();
  hideToastImmediately();
  resetDateInputsToDefault();
}

// chrome.runtime.lastErrorを通常のErrorとして扱えるようにする。
function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      const token = typeof result === "string" ? result : result?.token;
      if (!token) {
        reject(new Error("アクセストークンを取得できませんでした"));
        return;
      }

      resolve(token);
    });
  });
}

function removeCachedAuthToken(token) {
  return new Promise((resolve, reject) => {
    chrome.identity.removeCachedAuthToken({ token }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

// アカウント切り替え・ログアウト時に、このブラウザにキャッシュされた全トークンを破棄する。
function clearAllCachedAuthTokens() {
  return new Promise((resolve, reject) => {
    chrome.identity.clearAllCachedAuthTokens(() => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

// Calendar APIのHTTPエラーを、ネットワークエラー等と区別するための専用エラー型。
class CalendarApiError extends Error {
  constructor(status) {
    super("Calendar API error");
    this.name = "CalendarApiError";
    this.status = status;
  }
}

// chrome.identity系のエラーを、原因ごとに分かりやすい文言へ変換する。
// エラーの内部メッセージ（トークンを含みうる）はここでのみ判定に使い、画面には出さない。
function classifyAuthError(error) {
  const message =
    error && typeof error.message === "string" ? error.message.toLowerCase() : "";

  if (message.includes("did not approve")) {
    return "ログインがキャンセルされました";
  }
  if (message.includes("not granted") || message.includes("revoked") || message.includes("denied")) {
    return "Googleカレンダーへのアクセス権限が拒否されました";
  }
  if (message.includes("not signed in") || message.includes("no accounts") || message.includes("sign in")) {
    return "Googleにログインしていません。ブラウザでGoogleアカウントにログインしてください";
  }
  return "ログインに失敗しました。しばらくしてから再度お試しください";
}

// Calendar API呼び出し中のエラーを、権限エラー/ネットワークエラー/その他に分類する。
function describeRequestError(error) {
  if (error instanceof CalendarApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Googleカレンダーへのアクセス権限がありません";
    }
    return "カレンダー情報の取得に失敗しました";
  }
  if (typeof TypeError !== "undefined" && error instanceof TypeError) {
    return "ネットワークエラーが発生しました。接続を確認してください";
  }
  return "予期しないエラーが発生しました";
}

// manifest.jsonのoauth2設定を使ってChromeからトークンを取得する（ユーザーがボタンを押した時のみ）。
async function login() {
  loginBtn.disabled = true;
  try {
    accessToken = await getAuthToken(true);
    showLoggedIn();
    setStatus("");
    const loaded = await loadCalendarList();
    if (loaded) {
      handleSearch();
    }
  } catch (error) {
    showLoggedOut();
    setStatus(classifyAuthError(error), true);
  } finally {
    loginBtn.disabled = false;
  }
}

// 現在のアカウントからログアウトし、別のGoogleアカウントで再認証する。
async function switchAccount() {
  switchAccountBtn.disabled = true;
  try {
    await clearAllCachedAuthTokens();
    resetSessionState();
    setStatus("アカウントを切り替えています…");
    accessToken = await getAuthToken(true);
    showLoggedIn();
    setStatus("");
    const loaded = await loadCalendarList();
    if (loaded) {
      handleSearch();
    }
  } catch (error) {
    resetSessionState();
    showLoggedOut();
    setStatus(classifyAuthError(error), true);
  } finally {
    switchAccountBtn.disabled = false;
  }
}

// ログアウトする。ログアウト直後にinteractive認証は開始しない。
async function logout() {
  logoutBtn.disabled = true;
  try {
    await clearAllCachedAuthTokens();
  } catch (error) {
    // キャッシュ削除に失敗しても、ローカルの表示はログアウト状態へ進める。
  }
  resetSessionState();
  showLoggedOut();
  setStatus("ログアウトしました");
  logoutBtn.disabled = false;
}

// APIが401を返した場合はキャッシュを削除し、1回だけ再認証して再送する。
async function fetchWithAuth(url, options = {}, retryOnUnauthorized = true) {
  if (!accessToken) {
    accessToken = await getAuthToken(false);
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status !== 401) {
    return response;
  }

  if (!retryOnUnauthorized) {
    throw new CalendarApiError(response.status);
  }

  const expiredToken = accessToken;
  accessToken = null;
  await removeCachedAuthToken(expiredToken);
  accessToken = await getAuthToken(true);
  showLoggedIn();

  return fetchWithAuth(url, options, false);
}

// 既存のログイン状態があれば、操作なし（非対話）でトークンを復元する。
// 復元に失敗してもエラー扱いにはせず、未ログイン画面を表示するだけにする。
async function initializeAuthentication() {
  try {
    accessToken = await getAuthToken(false);
    showLoggedIn();
    const loaded = await loadCalendarList();
    if (loaded) {
      handleSearch();
    }
  } catch (error) {
    resetSessionState();
    showLoggedOut();
  }
}

// CalendarList APIから利用可能なカレンダーを取得する。
// 成功時はtrue、失敗時はfalseを返す（呼び出し側は成功時だけ検索を続行する）。
async function loadCalendarList() {
  try {
    const response = await fetchWithAuth(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    );

    if (!response.ok) {
      throw new CalendarApiError(response.status);
    }

    const data = await response.json();
    calendarList = (data.items || []).filter(
      (calendar) =>
        calendar.accessRole === "owner" ||
        calendar.accessRole === "writer" ||
        calendar.accessRole === "reader",
    );
    renderCalendarList();
    return true;
  } catch (error) {
    setStatus(describeRequestError(error), true);
    return false;
  }
}

// 取得したカレンダーを個別選択用チェックボックスとして表示する。
function renderCalendarList() {
  calendarListElement.replaceChildren();

  calendarList.forEach((calendar, index) => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.id = `calendar-${index}`;
    checkbox.value = calendar.id;
    checkbox.checked = true;
    checkbox.disabled = allCalendarsCheckbox.checked;

    label.htmlFor = checkbox.id;
    label.append(checkbox, document.createTextNode(calendar.summary));
    calendarListElement.appendChild(label);
  });
}

function getSelectedCalendarIds() {
  if (allCalendarsCheckbox.checked) {
    const ids = calendarList.map((calendar) => calendar.id);
    return ids.length > 0 ? ids : ["primary"];
  }

  const checked = Array.from(
    calendarListElement.querySelectorAll('input[type="checkbox"]:checked'),
  ).map((checkbox) => checkbox.value);

  return checked.length > 0 ? checked : ["primary"];
}

// 各カレンダーのイベントを取得し、1つの配列に統合する。
async function fetchEvents(calendarIds, timeMin, timeMax) {
  let allEvents = [];

  for (const calendarId of calendarIds) {
    const endpoint =
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events` +
      `?timeMin=${encodeURIComponent(timeMin)}` +
      `&timeMax=${encodeURIComponent(timeMax)}` +
      "&singleEvents=true&orderBy=startTime";

    const response = await fetchWithAuth(endpoint);

    if (!response.ok) {
      throw new CalendarApiError(response.status);
    }

    const data = await response.json();
    const events = (data.items || []).map((event) => ({
      start: event.start.dateTime || event.start.date,
      end: event.end.dateTime || event.end.date,
    }));
    allEvents = allEvents.concat(events);
  }

  return allEvents;
}

// 既存実装と同じく、毎日9:00〜22:00を30分単位で走査する。
function findFreeSlots(startDate, endDate, duration, events) {
  const slots = [];
  const start = parseLocalDateString(startDate);
  const end = parseLocalDateString(endDate);
  const now = new Date();

  for (
    let date = new Date(start);
    date <= end;
    date.setDate(date.getDate() + 1)
  ) {
    const isToday =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();

    let dayStart;

    if (isToday) {
      // 現在時刻を30分単位で切り捨てる（14:32→14:30）。
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const roundedMinutes =
        Math.floor(nowMinutes / STEP_MIN) * STEP_MIN;
      const startMinutes = Math.max(DAY_START * 60, roundedMinutes);
      dayStart = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        Math.floor(startMinutes / 60),
        startMinutes % 60,
        0,
      );
    } else {
      dayStart = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        DAY_START,
        0,
        0,
      );
    }

    const dayEnd = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      DAY_END,
      0,
      0,
    );
    const dayEvents = events
      .map((event) => ({
        start: new Date(event.start),
        end: new Date(event.end),
      }))
      .filter((event) => event.start < dayEnd && event.end > dayStart)
      .sort((first, second) => first.start - second.start);

    let cursor = new Date(dayStart);
    let blockStart = null;

    while (cursor < dayEnd) {
      const next = new Date(cursor.getTime() + STEP_MIN * 60000);
      const overlaps = dayEvents.some(
        (event) => event.start < next && event.end > cursor,
      );

      if (!overlaps) {
        if (blockStart === null) {
          blockStart = new Date(cursor);
        }
        cursor = next;
      } else {
        if (
          blockStart !== null &&
          cursor - blockStart >= duration * 60000
        ) {
          slots.push({
            start: new Date(blockStart),
            end: new Date(cursor),
          });
        }

        blockStart = null;
        const blockingEvents = dayEvents.filter(
          (event) => event.start < next && event.end > cursor,
        );
        const maximumEnd = new Date(
          Math.max(...blockingEvents.map((event) => event.end)),
        );
        cursor = maximumEnd > next ? maximumEnd : next;
      }
    }

    if (
      blockStart !== null &&
      cursor - blockStart >= duration * 60000
    ) {
      slots.push({
        start: new Date(blockStart),
        end: new Date(cursor < dayEnd ? cursor : dayEnd),
      });
    }
  }

  return slots;
}

// 開始日・終了日入力の値を検証し、期間検索を実行する。
// 1日だけの範囲（開始日=終了日）も同じ期間検索として扱う。
async function handleSearch() {
  const startValue = customStartDateInput.value;
  const endValue = customEndDateInput.value;

  if (!startValue || !endValue) {
    setStatus("開始日と終了日を選択してください", true);
    return;
  }

  const start = parseLocalDateString(startValue);
  const end = parseLocalDateString(endValue);

  if (start > end) {
    setStatus("開始日は終了日以前にしてください", true);
    return;
  }

  if (daysBetweenInclusive(start, end, 31) > 31) {
    setStatus("検索期間は31日以内にしてください", true);
    return;
  }

  await runPeriodSearch(start, end);
}

// 期間内のイベントをまとめて取得し、日付ごとの空き時間を計算する。
async function runPeriodSearch(start, end) {
  periodResults = [];
  periodIndex = 0;
  resultsElement.replaceChildren();
  copyAllBtn.hidden = true;
  periodPositionElement.hidden = true;
  setStatus("読み込み中…");

  try {
    if (calendarList.length === 0) {
      const loaded = await loadCalendarList();
      if (!loaded) {
        setStatus("カレンダー情報を取得できませんでした", true);
        return;
      }
    }

    const duration = Number(durationSelect.value);
    const calendarIds = getSelectedCalendarIds();
    const timeMin = `${toLocalDateString(start)}T00:00:00+09:00`;
    const timeMax = `${toLocalDateString(addDays(end, 1))}T00:00:00+09:00`;

    const events = await fetchEvents(calendarIds, timeMin, timeMax);

    const days = [];
    for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) {
      const dateStr = toLocalDateString(cursor);
      const slots = findFreeSlots(dateStr, dateStr, duration, events);
      days.push({ date: new Date(cursor), slots });
    }

    periodResults = days;
    periodIndex = 0;
    renderPeriodDay();
    setStatus("");
  } catch (error) {
    periodResults = [];
    periodIndex = 0;
    resultsElement.replaceChildren();
    copyAllBtn.hidden = true;
    periodPositionElement.hidden = true;
    periodPositionElement.textContent = "";
    periodBoundaryMessageElement.textContent = "";
    clearBoundaryAriaState();
    prevDayBtn.disabled = true;
    nextDayBtn.disabled = true;
    prevWeekBtn.disabled = true;
    nextWeekBtn.disabled = true;
    setStatus("空き時間の検索に失敗しました", true);
  }
}

// 期間検索結果のうち、現在のインデックスの日を表示する。
function renderPeriodDay() {
  const day = periodResults[periodIndex];
  displayedDate = day.date;
  renderDateHeaderText();
  currentSlots = day.slots;
  renderDayResultCard(day);
  updatePeriodNavigationButtons();
  updatePeriodBoundaryMessage();
}

// 期間検索モードでは、前日/翌日は結果配列内の移動、前週/翌週は無効化する。
// disabled属性は使わず、aria-disabledのみで見た目・意味上の無効を表現する
// （disabledにするとクリック/キーボード操作でイベントが発生せず、境界通知が出せないため）。
function updatePeriodNavigationButtons() {
  prevDayBtn.disabled = false;
  nextDayBtn.disabled = false;
  prevWeekBtn.disabled = false;
  nextWeekBtn.disabled = false;

  prevDayBtn.setAttribute("aria-disabled", periodIndex <= 0 ? "true" : "false");
  nextDayBtn.setAttribute(
    "aria-disabled",
    periodIndex >= periodResults.length - 1 ? "true" : "false",
  );
  prevWeekBtn.setAttribute("aria-disabled", "true");
  nextWeekBtn.setAttribute("aria-disabled", "true");

  prevWeekBtn.title = "検索期間中は週移動できません";
  nextWeekBtn.title = "検索期間中は週移動できません";
}

// 前週/翌週ボタンの案内表示を、1日検索モードに戻る際にクリアする。
function clearWeekNavigationHint() {
  prevWeekBtn.removeAttribute("title");
  nextWeekBtn.removeAttribute("title");
}

// 期間検索モードで付与したaria-disabledを、1日検索モードに戻る際・エラー時にクリアする。
function clearBoundaryAriaState() {
  prevDayBtn.removeAttribute("aria-disabled");
  nextDayBtn.removeAttribute("aria-disabled");
  prevWeekBtn.removeAttribute("aria-disabled");
  nextWeekBtn.removeAttribute("aria-disabled");
}

// 期間検索中、位置と境界状態を1行にまとめて表示する（例:「7 / 7　検索期間の最終日」）。
// periodBoundaryMessageElementは視覚的には非表示のスクリーンリーダー専用アナウンスとして使う
// （クリック時のトースト文言はshowToast側でそのまま維持し、ここでは変更しない）。
function updatePeriodBoundaryMessage() {
  if (periodResults.length === 0) {
    periodPositionElement.hidden = true;
    periodPositionElement.textContent = "";
    periodBoundaryMessageElement.textContent = "";
    return;
  }

  const positionText = `${periodIndex + 1} / ${periodResults.length}`;
  let boundaryLabel = "";

  if (periodResults.length === 1) {
    boundaryLabel = "この日のみ";
  } else if (periodIndex === 0) {
    boundaryLabel = "検索期間の開始日";
  } else if (periodIndex === periodResults.length - 1) {
    boundaryLabel = "検索期間の最終日";
  }

  periodPositionElement.hidden = false;
  periodPositionElement.textContent = boundaryLabel
    ? `${positionText}　${boundaryLabel}`
    : positionText;
  periodBoundaryMessageElement.textContent = boundaryLabel;
}

function movePeriodDay(delta) {
  const nextIndex = periodIndex + delta;
  if (nextIndex < 0 || nextIndex >= periodResults.length) {
    return;
  }
  periodIndex = nextIndex;
  renderPeriodDay();
}

// 検索条件（必要時間・対象カレンダー）変更時に、現在の開始日・終了日で再検索する。
function refreshCurrentSearch() {
  handleSearch();
}

function slotToTimeText(slot) {
  const startTime = `${pad(slot.start.getHours())}:${pad(slot.start.getMinutes())}`;
  const endTime = `${pad(slot.end.getHours())}:${pad(slot.end.getMinutes())}`;
  return `${startTime}〜${endTime}`;
}

function pad(number) {
  return String(number).padStart(2, "0");
}

function slotToText(slot) {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const date = `${slot.start.getMonth() + 1}月${slot.start.getDate()}日(${weekdays[slot.start.getDay()]})`;
  const startTime = `${pad(slot.start.getHours())}:${pad(slot.start.getMinutes())}`;
  const endTime = `${pad(slot.end.getHours())}:${pad(slot.end.getMinutes())}`;
  return `${date} ${startTime}〜${endTime}`;
}

function slotToCalendarUrl(slot) {
  const format = (date) =>
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}00`;

  return (
    "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    `&dates=${format(slot.start)}/${format(slot.end)}`
  );
}

// 完全な日付を「2026年7月27日（月）」の形式で返す。
function formatFullDateLabel(date) {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  return (
    `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日` +
    `（${weekdays[date.getDay()]}）`
  );
}

// 1件の空き時間カードを作る（コピー・予定作成ボタン付き）。
function buildSlotCard(slot) {
  const card = document.createElement("article");
  const text = document.createElement("p");
  const actions = document.createElement("div");
  const copyButton = document.createElement("button");
  const calendarButton = document.createElement("button");

  card.className = "slot-card";
  text.textContent = slotToTimeText(slot);
  actions.className = "slot-actions";

  copyButton.type = "button";
  copyButton.className = "btn-copy";
  copyButton.textContent = "コピー";
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(slotToText(slot));
      setStatus("コピーしました");
    } catch (error) {
      setStatus(`コピーに失敗しました: ${error.message}`, true);
    }
  });

  calendarButton.type = "button";
  calendarButton.className = "btn-calendar";
  calendarButton.textContent = "Googleカレンダーで予定作成";
  calendarButton.addEventListener("click", () => {
    window.open(slotToCalendarUrl(slot), "_blank", "noopener");
  });

  actions.append(copyButton, calendarButton);
  card.append(text, actions);
  return card;
}

// 現在表示中の日を、日付・件数・空き時間一覧をまとめた1つの日カードとして描画する。
function renderDayResultCard(day) {
  resultsElement.replaceChildren();

  const card = document.createElement("article");
  card.className = "day-result-card";

  const header = document.createElement("div");
  header.className = "day-result-header";

  const dateElement = document.createElement("p");
  dateElement.className = "day-result-date";
  dateElement.textContent = formatFullDateLabel(day.date);
  const weekday = day.date.getDay();
  dateElement.classList.toggle("sunday", weekday === 0);
  dateElement.classList.toggle("saturday", weekday === 6);

  const countElement = document.createElement("p");
  countElement.className = "day-result-count";
  countElement.textContent =
    day.slots.length > 0 ? `空き時間 ${day.slots.length}件` : "空き時間なし";

  header.append(dateElement, countElement);
  card.appendChild(header);

  if (day.slots.length > 0) {
    const body = document.createElement("div");
    body.className = "day-result-body";
    day.slots.forEach((slot) => {
      body.appendChild(buildSlotCard(slot));
    });
    card.appendChild(body);
  }

  resultsElement.appendChild(card);
  copyAllBtn.hidden = day.slots.length === 0;
}

// 検索結果を改行区切りでまとめてコピーする。
async function copyAllResults() {
  if (currentSlots.length === 0) {
    return;
  }

  try {
    const text = currentSlots.map(slotToText).join("\n");
    await navigator.clipboard.writeText(text);
    setStatus("全件コピーしました");
  } catch (error) {
    setStatus(`コピーに失敗しました: ${error.message}`, true);
  }
}

loginBtn.addEventListener("click", login);
switchAccountBtn.addEventListener("click", switchAccount);
logoutBtn.addEventListener("click", logout);
prevDayBtn.addEventListener("click", () => {
  if (periodResults.length === 0) {
    return;
  }
  if (periodIndex <= 0) {
    showToast("検索期間の開始日です");
    return;
  }
  movePeriodDay(-1);
});
prevWeekBtn.addEventListener("click", () => {
  if (periodResults.length === 0) {
    return;
  }
  showToast("検索期間中は週移動できません");
});
nextDayBtn.addEventListener("click", () => {
  if (periodResults.length === 0) {
    return;
  }
  if (periodIndex >= periodResults.length - 1) {
    showToast("検索期間の最終日です");
    return;
  }
  movePeriodDay(1);
});
nextWeekBtn.addEventListener("click", () => {
  if (periodResults.length === 0) {
    return;
  }
  showToast("検索期間中は週移動できません");
});
copyAllBtn.addEventListener("click", copyAllResults);

presetTodayBtn.addEventListener("click", () => applyPresetRange(getTodayRange, "presetTodayBtn"));
presetThisWeekBtn.addEventListener("click", () =>
  applyPresetRange(getThisWeekRange, "presetThisWeekBtn"),
);
presetNextWeekBtn.addEventListener("click", () =>
  applyPresetRange(getNextWeekRange, "presetNextWeekBtn"),
);
presetThisMonthBtn.addEventListener("click", () =>
  applyPresetRange(getThisMonthRange, "presetThisMonthBtn"),
);
presetNextMonthBtn.addEventListener("click", () =>
  applyPresetRange(getNextMonthRange, "presetNextMonthBtn"),
);

customStartDateInput.addEventListener("input", () => {
  clearActivePresetButton();
  updateConditionsToggleLabel();
});
customEndDateInput.addEventListener("input", () => {
  clearActivePresetButton();
  updateConditionsToggleLabel();
});

searchBtn.addEventListener("click", handleSearch);

conditionsToggle.addEventListener("click", () => {
  const willOpen = conditionsPanel.hidden;
  conditionsPanel.hidden = !willOpen;
  conditionsToggle.setAttribute("aria-expanded", String(willOpen));
  updateConditionsToggleLabel();
});

durationSelect.addEventListener("change", refreshCurrentSearch);
allCalendarsCheckbox.addEventListener("change", () => {
  calendarListElement
    .querySelectorAll('input[type="checkbox"]')
    .forEach((checkbox) => {
      checkbox.disabled = allCalendarsCheckbox.checked;
    });
  refreshCurrentSearch();
});
calendarListElement.addEventListener("change", (event) => {
  if (
    event.target.matches('input[type="checkbox"]') &&
    !allCalendarsCheckbox.checked
  ) {
    refreshCurrentSearch();
  }
});

resetDateInputsToDefault();
renderDateHeaderText();
initializeAuthentication();
