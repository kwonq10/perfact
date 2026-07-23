const DAY_START = 9;
const DAY_END = 22;
const STEP_MIN = 30;

let accessToken = null;
let currentSlots = [];
let calendarList = [];

const loginBtn = document.getElementById("loginBtn");
const authView = document.getElementById("authView");
const dayView = document.getElementById("dayView");
const displayDateElement = document.getElementById("displayDate");
const todayBadge = document.getElementById("todayBadge");
const prevDayBtn = document.getElementById("prevDayBtn");
const prevWeekBtn = document.getElementById("prevWeekBtn");
const nextDayBtn = document.getElementById("nextDayBtn");
const nextWeekBtn = document.getElementById("nextWeekBtn");
const conditionsToggle = document.getElementById("conditionsToggle");
const conditionsPanel = document.getElementById("conditionsPanel");
const durationSelect = document.getElementById("duration");
const calendarListElement = document.getElementById("calendarList");
const allCalendarsCheckbox = document.getElementById("allCalendars");
const statusElement = document.getElementById("status");
const resultsElement = document.getElementById("results");
const copyAllBtn = document.getElementById("copyAllBtn");

let displayedDate = startOfDay(new Date());

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

function updateDateHeader() {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const weekday = displayedDate.getDay();
  displayDateElement.textContent =
    `${displayedDate.getFullYear()}年${displayedDate.getMonth() + 1}月` +
    `${displayedDate.getDate()}日（${weekdays[weekday]}）`;
  displayDateElement.classList.toggle("sunday", weekday === 0);
  displayDateElement.classList.toggle("saturday", weekday === 6);

  const today = startOfDay(new Date());
  const isToday = isSameDay(displayedDate, today);
  todayBadge.hidden = !isToday;
  prevDayBtn.disabled = isToday;
  prevWeekBtn.disabled = isToday;
}

function moveDisplayedDate(days) {
  const nextDate = new Date(displayedDate);
  nextDate.setDate(nextDate.getDate() + days);
  const today = startOfDay(new Date());
  displayedDate = nextDate < today ? today : nextDate;
  updateDateHeader();
  searchCurrentDay();
}

// 状態メッセージとエラー表示を一箇所で切り替える。
function setStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", isError);
}

function showDayView() {
  authView.hidden = true;
  dayView.hidden = false;
  updateDateHeader();
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

// ログイン成功後の表示を更新する。
function showLoggedIn() {
  loginBtn.textContent = "ログイン済み";
  loginBtn.disabled = true;
}

// manifest.jsonのoauth2設定を使ってChromeからトークンを取得する。
async function login() {
  try {
    accessToken = await getAuthToken(true);
    showLoggedIn();
    setStatus("Googleアカウントと連携しました");
    await loadCalendarList();
  } catch (error) {
    setStatus(`ログインに失敗しました: ${error.message}`, true);
  }
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
    throw new Error("認証の更新後もCalendar APIが401を返しました");
  }

  const expiredToken = accessToken;
  accessToken = null;
  await removeCachedAuthToken(expiredToken);
  accessToken = await getAuthToken(true);
  showLoggedIn();

  return fetchWithAuth(url, options, false);
}

// 既存のログイン状態があれば、操作なしでトークンを復元する。
async function initializeAuthentication() {
  try {
    accessToken = await getAuthToken(false);
    showLoggedIn();
    setStatus("Googleアカウント連携済み");
    await loadCalendarList();
  } catch (error) {
    accessToken = null;
  }
}

// CalendarList APIから利用可能なカレンダーを取得する。
async function loadCalendarList() {
  try {
    const response = await fetchWithAuth(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    );

    if (!response.ok) {
      throw new Error(`CalendarList API: ${response.status}`);
    }

    const data = await response.json();
    calendarList = (data.items || []).filter(
      (calendar) =>
        calendar.accessRole === "owner" ||
        calendar.accessRole === "writer" ||
        calendar.accessRole === "reader",
    );
    renderCalendarList();
    if (dayView.hidden) {
      showDayView();
      searchCurrentDay();
    }
  } catch (error) {
    setStatus(`カレンダー一覧の取得に失敗しました: ${error.message}`, true);
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
      throw new Error(`Events API: ${response.status}`);
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
  const [startYear, startMonth, startDay] = startDate.split("-").map(Number);
  const [endYear, endMonth, endDay] = endDate.split("-").map(Number);
  const start = new Date(startYear, startMonth - 1, startDay);
  const end = new Date(endYear, endMonth - 1, endDay);
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

// 表示中の1日についてイベント取得と空き時間計算を実行する。
async function searchCurrentDay() {
  if (!accessToken) {
    return;
  }

  const date = toLocalDateString(displayedDate);
  const duration = Number(durationSelect.value);
  resultsElement.replaceChildren();
  copyAllBtn.hidden = true;
  setStatus("読み込み中…");

  try {
    if (calendarList.length === 0) {
      await loadCalendarList();
    }

    const timeMin = `${date}T00:00:00+09:00`;
    const timeMax = `${date}T23:59:59+09:00`;
    const calendarIds = getSelectedCalendarIds();
    const events = await fetchEvents(calendarIds, timeMin, timeMax);

    currentSlots = findFreeSlots(date, date, duration, events);
    renderResults(currentSlots);
    setStatus(`${currentSlots.length}件の空き枠が見つかりました`);
  } catch (error) {
    currentSlots = [];
    copyAllBtn.hidden = true;
    setStatus(`エラーが発生しました: ${error.message}`, true);
  }
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

// 結果カードを縦に追加し、ボタンには直接イベントを設定する。
function renderResults(slots) {
  resultsElement.replaceChildren();

  if (slots.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.textContent = "この日は空き時間がありません";
    resultsElement.appendChild(emptyMessage);
    copyAllBtn.hidden = true;
    return;
  }

  slots.forEach((slot) => {
    const card = document.createElement("article");
    const text = document.createElement("p");
    const copyButton = document.createElement("button");
    const calendarButton = document.createElement("button");

    card.className = "slot-card";
    text.textContent = slotToTimeText(slot);

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

    card.append(text, copyButton, calendarButton);
    resultsElement.appendChild(card);
  });

  copyAllBtn.hidden = false;
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
prevDayBtn.addEventListener("click", () => moveDisplayedDate(-1));
prevWeekBtn.addEventListener("click", () => moveDisplayedDate(-7));
nextDayBtn.addEventListener("click", () => moveDisplayedDate(1));
nextWeekBtn.addEventListener("click", () => moveDisplayedDate(7));
copyAllBtn.addEventListener("click", copyAllResults);

conditionsToggle.addEventListener("click", () => {
  const willOpen = conditionsPanel.hidden;
  conditionsPanel.hidden = !willOpen;
  conditionsToggle.setAttribute("aria-expanded", String(willOpen));
  conditionsToggle.textContent = willOpen ? "▲ 検索条件" : "▼ 検索条件";
});

durationSelect.addEventListener("change", searchCurrentDay);
allCalendarsCheckbox.addEventListener("change", () => {
  calendarListElement
    .querySelectorAll('input[type="checkbox"]')
    .forEach((checkbox) => {
      checkbox.disabled = allCalendarsCheckbox.checked;
    });
  searchCurrentDay();
});
calendarListElement.addEventListener("change", (event) => {
  if (
    event.target.matches('input[type="checkbox"]') &&
    !allCalendarsCheckbox.checked
  ) {
    searchCurrentDay();
  }
});

updateDateHeader();
initializeAuthentication();
