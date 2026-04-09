const http = require("http");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const HOST = "0.0.0.0";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ROOT = __dirname;
const USERS_FILE = path.join(ROOT, "data", "users.json");
const APP_DATA_FILE = path.join(ROOT, "data", "app-data.json");
const MEMBER_NAMES = ["Mark", "Tom", "Rob", "Paul", "Niek", "Bertus", "Wiel", "Hans", "George", "Jan", "Guus"];
const AVAILABLE_YEARS = [2026, 2027];
const SAILING_POINTS_PER_SHARE = 28;
const MEMBER_COLORS = {
  Mark: "#1f6f8b",
  Tom: "#c84b31",
  Rob: "#5b8c5a",
  Paul: "#8b5e3c",
  Niek: "#6a4c93",
  Bertus: "#c97b17",
  Wiel: "#2a9d8f",
  Hans: "#b56576",
  George: "#577590",
  Jan: "#bc4749",
  Guus: "#7f5539",
};

const sessions = new Map();
const loginAttempts = new Map();

const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const RATE_LIMIT_WINDOW_MS = 1000 * 60 * 10;
const RATE_LIMIT_MAX_ATTEMPTS = 5;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function createSession() {
  const id = crypto.randomBytes(32).toString("hex");
  const session = {
    id,
    csrfToken: crypto.randomBytes(24).toString("hex"),
    createdAt: Date.now(),
    userEmail: null,
  };
  sessions.set(id, session);
  return session;
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  const cookiePairs = cookieHeader.split(";").map((item) => item.trim()).filter(Boolean);
  const cookies = {};

  for (const pair of cookiePairs) {
    const index = pair.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = pair.slice(0, index);
    const value = pair.slice(index + 1);
    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function serializeSessionCookie(sessionId, expires = "") {
  const parts = [
    `sessionId=${encodeURIComponent(sessionId)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];

  if (expires) {
    parts.push(`Expires=${expires}`);
  }

  return parts.join("; ");
}

function getSession(req, res) {
  cleanupSessions();
  const cookies = parseCookies(req);
  const existing = cookies.sessionId ? sessions.get(cookies.sessionId) : null;

  if (existing) {
    existing.createdAt = Date.now();
    return existing;
  }

  const session = createSession();
  res.setHeader("Set-Cookie", serializeSessionCookie(session.id));
  return session;
}

function clearSession(res, sessionId) {
  if (sessionId) {
    sessions.delete(sessionId);
  }
  res.setHeader(
    "Set-Cookie",
    serializeSessionCookie("", "Thu, 01 Jan 1970 00:00:00 GMT"),
  );
}

async function ensureDataDir() {
  await fsp.mkdir(path.dirname(USERS_FILE), { recursive: true });
}

async function readUsers() {
  await ensureDataDir();

  try {
    const raw = await fsp.readFile(USERS_FILE, "utf8");
    const users = JSON.parse(raw);
    return Array.isArray(users) ? users : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeUsers(users) {
  await ensureDataDir();
  await fsp.writeFile(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

function defaultAppData() {
  return {
    planningItems: [],
    planningReservations: [],
    cancellationPenalties: [],
    sailingRightsShares: Object.fromEntries(MEMBER_NAMES.map((name) => [name, 0])),
    logboekItems: [],
    informatie: {
      schip: "Bavaria 38 uit 2003 met ligplaats in Colijnsplaat.",
      veiligheid: "Voeg hier veiligheidsprocedures, checklists en noodnummers toe.",
      contact: "Voeg hier contactgegevens en verenigingsafspraken toe.",
    },
    kasboekItems: [],
  };
}

async function readAppData() {
  await ensureDataDir();

  try {
    const raw = await fsp.readFile(APP_DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const data = { ...defaultAppData(), ...parsed };

    if ((!Array.isArray(parsed.planningReservations) || parsed.planningReservations.length === 0) && Array.isArray(parsed.planningItems) && parsed.planningItems.length > 0) {
      data.planningReservations = parsed.planningItems.map((item) => ({
        id: item.id || createId(),
        startDate: item.datum,
        endDate: item.datum,
        members: String(item.titel || "Onbekend").split(",").map((name) => name.trim()).filter(Boolean),
        purpose: item.type || "Reservering",
        notes: item.opmerking || "",
        points: getPointsForRange(item.datum, item.datum).totalPoints,
        createdBy: item.createdBy || "werkmodus",
        createdAt: item.createdAt || new Date().toISOString(),
      }));
    }

    data.planningReservations = (data.planningReservations || []).map((reservation) => ({
      ...reservation,
      members: Array.isArray(reservation.members)
        ? reservation.members
        : String(reservation.members || "")
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean),
    }));

    const existingShares = data.sailingRightsShares && typeof data.sailingRightsShares === "object"
      ? data.sailingRightsShares
      : {};
    data.sailingRightsShares = Object.fromEntries(
      MEMBER_NAMES.map((name) => [name, Number(existingShares[name] || 0)]),
    );

    return data;
  } catch (error) {
    if (error.code === "ENOENT") {
      const initial = defaultAppData();
      await writeAppData(initial);
      return initial;
    }
    throw error;
  }
}

async function writeAppData(data) {
  await ensureDataDir();
  await fsp.writeFile(APP_DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function createId() {
  return crypto.randomBytes(10).toString("hex");
}

function formatDate(value) {
  if (!value) {
    return "";
  }
  return escapeHtml(value);
}

function renderEmptyState(text) {
  return `<div class="card"><p class="meta">${escapeHtml(text)}</p></div>`;
}

function setFlash(session, type, message) {
  session.flash = { type, message };
}

function takeFlash(session) {
  const flash = session.flash || null;
  delete session.flash;
  return flash;
}

function parseDateString(dateString) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || "").trim());
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

function eachDateInRange(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate.getTime());
  while (current <= endDate) {
    dates.push(toDateString(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function pointsForDate(dateString) {
  const date = parseDateString(dateString);
  if (!date) {
    return 0;
  }
  const month = date.getUTCMonth() + 1;
  if (month >= 1 && month <= 3) {
    return 1;
  }
  if (month === 4) {
    return 2;
  }
  if (month >= 5 && month <= 9) {
    return 4;
  }
  if (month === 10) {
    return 2;
  }
  return 1;
}

function getPointsForRange(startDateString, endDateString) {
  const startDate = parseDateString(startDateString);
  const endDate = parseDateString(endDateString);
  if (!startDate || !endDate || startDate > endDate) {
    return { totalPoints: 0, days: [] };
  }

  const days = eachDateInRange(startDate, endDate).map((dateString) => ({
    date: dateString,
    points: pointsForDate(dateString),
  }));

  return {
    totalPoints: days.reduce((sum, day) => sum + day.points, 0),
    days,
  };
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, amount) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

function kingsDayDate(year) {
  const date = new Date(Date.UTC(year, 3, 27));
  if (date.getUTCDay() === 0) {
    date.setUTCDate(26);
  }
  return date;
}

function liberationDayDate(year) {
  return new Date(Date.UTC(year, 4, 5));
}

function dutchHolidays(year) {
  const easter = easterSunday(year);
  const holidays = [
    { date: new Date(Date.UTC(year, 0, 1)), name: "Nieuwjaarsdag" },
    { date: addDays(easter, 1), name: "Tweede paasdag" },
    { date: kingsDayDate(year), name: "Koningsdag" },
    { date: liberationDayDate(year), name: "Bevrijdingsdag" },
    { date: addDays(easter, 39), name: "Hemelvaartsdag" },
    { date: addDays(easter, 50), name: "Tweede pinksterdag" },
    { date: new Date(Date.UTC(year, 11, 25)), name: "Eerste kerstdag" },
    { date: new Date(Date.UTC(year, 11, 26)), name: "Tweede kerstdag" },
  ];

  return new Map(holidays.map((holiday) => [toDateString(holiday.date), holiday.name]));
}

function weekdayIndexMondayFirst(date) {
  const day = date.getUTCDay();
  return day === 0 ? 6 : day - 1;
}

function memberColor(name) {
  return MEMBER_COLORS[name] || "#1d6072";
}

function reservationBackgroundStyle(reservation) {
  if (!reservation || !Array.isArray(reservation.members) || reservation.members.length === 0) {
    return "";
  }

  const colors = reservation.members.map((member) => memberColor(member));
  if (colors.length === 1) {
    return `background: color-mix(in srgb, ${colors[0]} 22%, white); border-color: color-mix(in srgb, ${colors[0]} 42%, white);`;
  }

  const step = 100 / colors.length;
  const stops = colors.map((color, index) => {
    const start = Math.round(index * step);
    const end = Math.round((index + 1) * step);
    return `${color} ${start}% ${end}%`;
  }).join(", ");

  return `background: linear-gradient(135deg, ${stops}); border-color: rgba(15, 47, 58, 0.18);`;
}

function normalizePlanningYear(value) {
  const year = Number(value);
  return AVAILABLE_YEARS.includes(year) ? year : AVAILABLE_YEARS[0];
}

function buildPlanningCalendar(reservations, selectedYear) {
  const months = [];
  const reservationByDate = new Map();
  const todayString = toDateString(new Date());

  for (const reservation of reservations) {
    for (const day of eachDateInRange(parseDateString(reservation.startDate), parseDateString(reservation.endDate))) {
      reservationByDate.set(day, reservation);
    }
  }

  for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
    const monthDate = new Date(Date.UTC(selectedYear, monthIndex, 1));
    const year = monthDate.getUTCFullYear();
    const month = monthDate.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const monthName = monthDate.toLocaleString("nl-NL", { month: "long", year: "numeric", timeZone: "UTC" });
    const holidays = dutchHolidays(year);
    const days = [];
    const leadingEmpty = weekdayIndexMondayFirst(monthDate);

    for (let index = 0; index < leadingEmpty; index += 1) {
      days.push({
        empty: true,
        key: `${monthName}-empty-${index}`,
      });
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(Date.UTC(year, month, day));
      const dateString = toDateString(date);
      days.push({
        date: dateString,
        day,
        points: pointsForDate(dateString),
        isWeekend: date.getUTCDay() === 0 || date.getUTCDay() === 6,
        isToday: dateString === todayString,
        holidayName: holidays.get(dateString) || "",
        reservation: reservationByDate.get(dateString) || null,
      });
    }

    months.push({ monthName, monthNumber: month + 1, days });
  }

  return months;
}

function findReservationConflict(reservations, startDateString, endDateString) {
  const requested = getPointsForRange(startDateString, endDateString).days.map((day) => day.date);
  for (const reservation of reservations) {
    const reservedDates = eachDateInRange(parseDateString(reservation.startDate), parseDateString(reservation.endDate));
    const conflictDate = requested.find((date) => reservedDates.includes(date));
    if (conflictDate) {
      return {
        reservation,
        conflictDate,
      };
    }
  }
  return null;
}

function memberLabel(members) {
  return members.map((member) => escapeHtml(member)).join(", ");
}

function calculateMemberTotals(reservations) {
  const totals = new Map(MEMBER_NAMES.map((name) => [name, 0]));

  for (const reservation of reservations) {
    if (!Array.isArray(reservation.members) || reservation.members.length === 0) {
      continue;
    }
    const share = reservation.points / reservation.members.length;
    for (const member of reservation.members) {
      totals.set(member, (totals.get(member) || 0) + share);
    }
  }

  return MEMBER_NAMES.map((name) => ({
    name,
    points: totals.get(name) || 0,
  }));
}

function reservationDayCount(reservation) {
  const start = parseDateString(reservation.startDate);
  const end = parseDateString(reservation.endDate);
  if (!start || !end || start > end) {
    return 0;
  }
  return eachDateInRange(start, end).length;
}

function calculateSailingRightsOverview(data, selectedYear) {
  const sharesByMember = data.sailingRightsShares || {};
  const totals = new Map(MEMBER_NAMES.map((name) => [name, 0]));
  let totalBookedPoints = 0;

  for (const reservation of data.planningReservations || []) {
    const startDate = String(reservation.startDate || "");
    if (!startDate.startsWith(`${selectedYear}-`)) {
      continue;
    }
    if (!Array.isArray(reservation.members) || reservation.members.length === 0) {
      continue;
    }

    const points = Number(reservation.points || 0);
    totalBookedPoints += points;

    const share = points / reservation.members.length;
    for (const member of reservation.members) {
      totals.set(member, (totals.get(member) || 0) + share);
    }
  }

  const rows = MEMBER_NAMES.map((name) => {
    const shares = Number(sharesByMember[name] || 0);
    const usedPoints = totals.get(name) || 0;
    const entitledPoints = shares * SAILING_POINTS_PER_SHARE;
    let sailedDays = 0;

    for (const reservation of data.planningReservations || []) {
      const startDate = String(reservation.startDate || "");
      if (!startDate.startsWith(`${selectedYear}-`)) {
        continue;
      }
      if (!Array.isArray(reservation.members) || reservation.members.length === 0 || !reservation.members.includes(name)) {
        continue;
      }
      sailedDays += reservationDayCount(reservation) / reservation.members.length;
    }

    return {
      name,
      shares,
      usedPoints,
      entitledPoints,
      remainingPoints: entitledPoints - usedPoints,
      sailedDays,
    };
  });

  return {
    totalBookedPoints,
    rows,
  };
}

function daysUntil(dateString) {
  const target = parseDateString(dateString);
  if (!target) {
    return -1;
  }
  const today = parseDateString(toDateString(new Date()));
  const differenceMs = target.getTime() - today.getTime();
  return Math.floor(differenceMs / (1000 * 60 * 60 * 24));
}

function cancellationPenaltyForReservation(reservation, overmacht) {
  if (overmacht) {
    return {
      penaltyPoints: 0,
      ruleText: "Overmacht: geen verlies van zeilpunten.",
    };
  }

  const daysBeforeStart = daysUntil(reservation.startDate);
  const totalPoints = Number(reservation.points || 0);

  if (daysBeforeStart >= 10) {
    return {
      penaltyPoints: 0,
      ruleText: "Annulering tot 10 dagen voor aanvang: geen verlies van zeilpunten.",
    };
  }

  if (daysBeforeStart >= 2) {
    return {
      penaltyPoints: totalPoints / 2,
      ruleText: "Annulering tot 2 dagen voor aanvang: de helft van de zeilpunten vervalt.",
    };
  }

  return {
    penaltyPoints: totalPoints,
    ruleText: "Annulering binnen 2 dagen voor aanvang: alle zeilpunten vervallen.",
  };
}

function cancellationLeadDays(startDateString, cancelledAtString) {
  const start = parseDateString(startDateString);
  if (!start) {
    return null;
  }
  const cancelledAt = cancelledAtString ? new Date(cancelledAtString) : new Date();
  const cancelledDate = parseDateString(toDateString(cancelledAt));
  if (!cancelledDate) {
    return null;
  }
  return Math.floor((start.getTime() - cancelledDate.getTime()) / (1000 * 60 * 60 * 24));
}

function requireAuthenticated(session) {
  return true;
}

function scryptHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey.toString("hex"));
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scryptHash(password, salt);
  return { salt, hash };
}

async function verifyPassword(password, user) {
  const expected = Buffer.from(user.hash, "hex");
  const actual = Buffer.from(await scryptHash(password, user.salt), "hex");
  if (expected.length !== actual.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, actual);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 10_000) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}

function parseForm(rawBody) {
  const params = new URLSearchParams(rawBody);
  const result = {};

  for (const [key, value] of params.entries()) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      if (Array.isArray(result[key])) {
        result[key].push(value);
      } else {
        result[key] = [result[key], value];
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStrongPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= 12 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password)
  );
}

function loginKey(req, email) {
  return `${req.socket.remoteAddress || "unknown"}:${normalizeEmail(email)}`;
}

function recordFailedAttempt(key) {
  const now = Date.now();
  const current = loginAttempts.get(key) || [];
  const next = current.filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
  next.push(now);
  loginAttempts.set(key, next);
}

function clearFailedAttempts(key) {
  loginAttempts.delete(key);
}

function isRateLimited(key) {
  const now = Date.now();
  const attempts = (loginAttempts.get(key) || []).filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
  loginAttempts.set(key, attempts);
  return attempts.length >= RATE_LIMIT_MAX_ATTEMPTS;
}

async function readAdminUser() {
  const users = await readUsers();
  return users.find((user) => user && user.role === "admin") || null;
}

function isAdminAuthenticated(session) {
  return Boolean(session && session.adminEmail);
}

function csvValue(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function buildCsv(rows) {
  return rows.map((row) => row.map(csvValue).join(",")).join("\r\n");
}

function buildLogboekCsv(items) {
  const rows = [[
    "vertrekdatum",
    "aankomstdatum",
    "windkracht_bij_vertrek",
    "motoruren_bij_vertrek",
    "motoruren_bij_aankomst",
    "route",
    "aangedane_havens",
    "schipper",
    "opvarenden",
    "dieselolie_ingenomen_liter",
    "voorraad_water_bij_vertrek_van_boort",
    "voorraad_diesel_bij_vertrek_van_boort",
    "schade_bijzonderheden",
  ]];

  for (const item of items) {
    rows.push([
      item.vertrekDatum || item.datum || "",
      item.aankomstDatum || "",
      item.windkracht || "",
      item.motorurenVertrek || "",
      item.motorurenAankomst || "",
      item.route || "",
      item.havens || "",
      item.schipper || "",
      item.opvarenden || "",
      item.dieselIngenomen || "",
      item.voorraadWater || "",
      item.voorraadDiesel || "",
      item.schade || "",
    ]);
  }

  return buildCsv(rows);
}

function buildPlanningCsv(items) {
  const rows = [[
    "startdatum",
    "einddatum",
    "leden",
    "punten",
    "dagen",
    "aangemaakt_op",
  ]];

  for (const item of items) {
    rows.push([
      item.startDate || "",
      item.endDate || "",
      Array.isArray(item.members) ? item.members.join(", ") : "",
      Number(item.points || 0).toFixed(2),
      reservationDayCount(item).toFixed(1),
      item.createdAt || "",
    ]);
  }

  return buildCsv(rows);
}

function buildKasboekCsv(items) {
  const rows = [[
    "datum",
    "omschrijving",
    "bedrag",
  ]];

  for (const item of items) {
    rows.push([
      item.datum || "",
      item.omschrijving || "",
      Number(item.bedrag || 0).toFixed(2),
    ]);
  }

  return buildCsv(rows);
}

function buildZeildagenCsv(overview) {
  const rows = [[
    "lid",
    "zeilpunten_verbruikt",
    "aandelen",
    "zeilpunten_recht",
    "zeilpunten_over",
  ]];

  for (const row of overview.rows) {
    rows.push([
      row.name,
      row.usedPoints.toFixed(2),
      String(row.shares),
      row.entitledPoints.toFixed(0),
      row.remainingPoints.toFixed(2),
    ]);
  }

  return buildCsv(rows);
}

function baseLayout({ title, content }) {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --card: rgba(255, 252, 244, 0.94);
      --navy: #0f2f3a;
      --sea: #1d6072;
      --line: rgba(15, 47, 58, 0.12);
      --danger: #a84331;
      --success: #2a6c53;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      color: var(--navy);
      background:
        radial-gradient(circle at top left, rgba(255,255,255,0.7), transparent 24%),
        linear-gradient(180deg, #d7e7eb 0%, #f5efe2 55%, #e5dcc6 100%);
    }
    .wrap {
      width: min(1360px, calc(100% - 24px));
      margin: 32px auto;
      padding: 28px;
      border-radius: 28px;
      background: var(--card);
      border: 1px solid var(--line);
      box-shadow: 0 20px 60px rgba(15, 47, 58, 0.14);
    }
    .top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 28px;
      flex-wrap: wrap;
    }
    h1 {
      margin: 0 0 12px;
      font-size: clamp(2.2rem, 5vw, 3.8rem);
    }
    p, li, label, input, button, a { font-size: 1rem; }
    p, li { line-height: 1.7; }
    .back, .button {
      display: inline-block;
      padding: 12px 18px;
      border-radius: 999px;
      text-decoration: none;
      font-weight: 700;
      border: 0;
      cursor: pointer;
    }
    .back { background: rgba(29, 96, 114, 0.1); color: var(--sea); }
    .button { background: var(--navy); color: white; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-top: 24px;
    }
    .card {
      padding: 20px;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.72);
      border: 1px solid var(--line);
    }
    .notice {
      padding: 14px 16px;
      border-radius: 16px;
      margin: 18px 0;
    }
    .notice.error {
      color: var(--danger);
      background: rgba(168, 67, 49, 0.08);
      border: 1px solid rgba(168, 67, 49, 0.18);
    }
    .notice.success {
      color: var(--success);
      background: rgba(42, 108, 83, 0.08);
      border: 1px solid rgba(42, 108, 83, 0.18);
    }
    form {
      display: grid;
      gap: 14px;
      margin-top: 18px;
    }
    .field {
      display: grid;
      gap: 8px;
    }
    input,
    select,
    textarea {
      width: 100%;
      padding: 14px 16px;
      border-radius: 14px;
      border: 1px solid var(--line);
      font: inherit;
      background: #fffdf8;
    }
    textarea {
      min-height: 110px;
      resize: vertical;
    }
    .meta {
      color: rgba(15, 47, 58, 0.75);
      font-size: 0.95rem;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
    }
    .planning-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 280px;
      gap: 18px;
      align-items: start;
    }
    .planning-sidebar {
      position: sticky;
      top: 24px;
      display: grid;
      gap: 18px;
    }
    .member-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 10px;
    }
    .member-chip {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #fffdf8;
    }
    .calendar-months {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }
    .calendar-scroller {
      max-height: 78vh;
      overflow: auto;
      padding-right: 6px;
      margin-top: 12px;
    }
    .year-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .year-links {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .month-jumps {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .calendar-days {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 6px;
      margin-top: 10px;
    }
    .calendar-weekdays {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 8px;
      margin-top: 14px;
      margin-bottom: 8px;
    }
    .calendar-weekday {
      padding: 6px 8px;
      font-size: 0.8rem;
      font-weight: 700;
      color: rgba(15, 47, 58, 0.72);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .calendar-empty {
      min-height: 84px;
      border-radius: 12px;
      background: rgba(15, 47, 58, 0.03);
      border: 1px dashed rgba(15, 47, 58, 0.06);
    }
    .calendar-cell {
      width: 100%;
      min-height: 84px;
      padding: 6px;
      border-radius: 10px;
      border: 1px solid rgba(15, 47, 58, 0.08);
      background: #ffffff;
      color: var(--navy);
      text-align: left;
      cursor: pointer;
      overflow: hidden;
    }
    .calendar-cell.reserved {
      background: rgba(168, 67, 49, 0.12);
      cursor: pointer;
    }
    .calendar-cell.selected {
      background: rgba(29, 96, 114, 0.24);
      border-color: rgba(29, 96, 114, 0.4);
    }
    .calendar-cell.in-range {
      background: rgba(29, 96, 114, 0.14);
      border-color: rgba(29, 96, 114, 0.22);
    }
    .calendar-cell:disabled {
      opacity: 1;
    }
    .calendar-cell.weekend {
      box-shadow: inset 0 0 0 1px rgba(201, 111, 59, 0.2);
      background: #f7f7f7;
    }
    .calendar-cell.today {
      border-color: rgba(15, 47, 58, 0.42);
      box-shadow: inset 0 0 0 2px rgba(15, 47, 58, 0.18);
    }
    .calendar-day {
      font-weight: 700;
      margin-bottom: 4px;
      font-size: 0.92rem;
    }
    .calendar-points {
      font-size: 0.72rem;
      color: rgba(15, 47, 58, 0.72);
      margin-bottom: 3px;
    }
    .calendar-status {
      font-size: 0.7rem;
      color: rgba(15, 47, 58, 0.9);
      line-height: 1.2;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
      word-break: break-word;
    }
    .calendar-tag {
      display: inline-block;
      margin-top: 3px;
      padding: 1px 5px;
      border-radius: 999px;
      font-size: 0.62rem;
      background: rgba(15, 47, 58, 0.08);
      max-width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .holiday-tag {
      background: #efefef;
    }
    @media (max-width: 900px) {
      .planning-layout {
        grid-template-columns: 1fr;
      }
      .planning-sidebar {
        position: static;
      }
    }
  </style>
</head>
<body>
  <main class="wrap">${content}</main>
</body>
</html>`;
}

function membersNav(currentPath) {
  const links = [
    { href: "/planning", label: "Planning" },
    { href: "/zeildagen", label: "zeildagen" },
    { href: "/logboek", label: "logboek" },
    { href: "/informatie", label: "informatie" },
    { href: "/kasboek", label: "kasboek" },
  ];

  return `
    <nav class="grid" style="grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin-bottom: 18px;">
      ${links.map((link) => `
        <a
          class="back"
          href="${link.href}"
          style="${currentPath === link.href ? "background: #0f2f3a; color: white;" : ""} text-align: center;"
        >${link.label}</a>
      `).join("")}
    </nav>
  `;
}

function planningLoginPage({ session, error = "" }) {
  const errorBlock = error ? `<div class="notice error">${escapeHtml(error)}</div>` : "";
  return baseLayout({
    title: "Planning login | de Rederij",
    content: `
      <div class="top">
        <div>
          <h1>Planning</h1>
          <p>De site staat tijdelijk open zonder login, zodat we makkelijker kunnen doorbouwen.</p>
        </div>
        <a class="back" href="/index.html">Terug naar home</a>
      </div>
      ${errorBlock}
      <section class="card">
        <p class="meta">De inlogfunctie is tijdelijk uitgeschakeld. Je kunt direct verder op de pagina's voor planning, logboek, informatie en kasboek.</p>
        <div class="actions">
          <a class="button" href="/planning">Naar planning</a>
        </div>
      </section>
    `,
  });
}

function setupPage({ session, error = "" }) {
  const errorBlock = error ? `<div class="notice error">${escapeHtml(error)}</div>` : "";
  return baseLayout({
    title: "Account instellen | de Rederij",
    content: `
      <div class="top">
        <div>
          <h1>Eerste account</h1>
          <p>De account-setup is tijdelijk uitgeschakeld zolang we samen aan de inhoud werken.</p>
        </div>
        <a class="back" href="/planning">Naar planning</a>
      </div>
      ${errorBlock}
      <section class="card">
        <p class="meta">Later kunnen we de veilige login weer activeren. Voor nu gaan alle pagina's direct open.</p>
        <div class="actions">
          <a class="button" href="/planning">Verder zonder login</a>
        </div>
      </section>
    `,
  });
}

function planningPage({ email, session }) {
  const data = session.pageData;
  const selectedYear = normalizePlanningYear(session.selectedYear);
  const reservations = data.planningReservations
    .slice()
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const calendarMonths = buildPlanningCalendar(
    reservations.filter((reservation) => String(reservation.startDate || "").startsWith(`${selectedYear}-`)),
    selectedYear,
  );
  const memberTotals = calculateMemberTotals(reservations);
  const cancellations = (data.cancellationPenalties || []).slice().sort((a, b) => {
    return String(b.cancelledAt || "").localeCompare(String(a.cancelledAt || ""));
  });
  const flash = takeFlash(session);
  const flashBlock = flash ? `<div class="notice ${escapeHtml(flash.type)}">${escapeHtml(flash.message)}</div>` : "";

  return baseLayout({
    title: "Planning | de Rederij",
    content: `
      <div class="top">
        <div>
          <h1>Planning</h1>
          <p>Tijdelijke werkmodus zonder login. Later zetten we de beveiligde toegang weer terug.</p>
        </div>
        <a class="back" href="/index.html">Terug naar home</a>
      </div>
      ${membersNav("/planning")}
      ${flashBlock}
      <div class="planning-layout">
        <div>
          <section class="card">
            <strong>Boot reserveren</strong>
            <p class="meta">Kies eerst in de kalender een begin- en einddag. De eerste reservering heeft voorrang en bezette dagen kun je niet opnieuw selecteren.</p>
            <form method="post" action="/planning" id="planning-form">
              <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
              <input type="hidden" name="year" value="${selectedYear}">
              <input type="hidden" name="startDate" id="planning-start" required>
              <input type="hidden" name="endDate" id="planning-end" required>
              <div class="field">
                <label>Gekozen periode</label>
                <div class="card" id="planning-selection-text">Nog geen dagen geselecteerd.</div>
              </div>
              <div class="field">
                <label>Leden</label>
                <div class="member-grid">
                  ${MEMBER_NAMES.map((name) => `
                    <label class="member-chip">
                      <input type="checkbox" name="members" value="${escapeHtml(name)}" style="width: auto; padding: 0;">
                      <span>${escapeHtml(name)}</span>
                    </label>
                  `).join("")}
                </div>
              </div>
              <div class="actions">
                <button class="button" type="submit">Reservering opslaan</button>
                <button class="back" type="button" id="planning-reset">Selectie wissen</button>
              </div>
            </form>
          </section>
          <section class="card" style="margin-top: 18px;">
            <strong>Agenda</strong>
            <div class="year-toolbar">
              <p class="meta" style="margin: 0;">Compact jaaroverzicht. Kies een jaar en scroll binnen de kalender zelf.</p>
              <div class="year-links">
                ${AVAILABLE_YEARS.map((year) => `
                  <a class="back" href="/planning?year=${year}" style="${year === selectedYear ? "background: #0f2f3a; color: white;" : ""}">${year}</a>
                `).join("")}
              </div>
            </div>
            <div class="month-jumps">
              ${calendarMonths.map((month, index) => `
                <a class="back" href="#month-${selectedYear}-${index + 1}" style="padding: 8px 12px;">${escapeHtml(month.monthName.split(" ")[0])}</a>
              `).join("")}
            </div>
            <div class="calendar-scroller">
            <div class="calendar-months">
              ${calendarMonths.map((month) => `
                <section class="card" id="month-${selectedYear}-${month.monthNumber}">
                  <strong style="text-transform: capitalize;">${escapeHtml(month.monthName)}</strong>
                  <div class="calendar-weekdays">
                    <div class="calendar-weekday">Ma</div>
                    <div class="calendar-weekday">Di</div>
                    <div class="calendar-weekday">Wo</div>
                    <div class="calendar-weekday">Do</div>
                    <div class="calendar-weekday">Vr</div>
                    <div class="calendar-weekday">Za</div>
                    <div class="calendar-weekday">Zo</div>
                  </div>
                  <div class="calendar-days">
                    ${month.days.map((day) => `
                      ${day.empty ? `
                        <div class="calendar-empty"></div>
                      ` : `
                      <button
                        type="button"
                        class="calendar-cell${day.reservation ? " reserved" : ""}${day.isWeekend ? " weekend" : ""}${day.isToday ? " today" : ""}"
                        data-date="${escapeHtml(day.date)}"
                        data-reserved="${day.reservation ? "true" : "false"}"
                        data-reservation-id="${day.reservation ? escapeHtml(day.reservation.id) : ""}"
                        data-members="${day.reservation ? escapeHtml(memberLabel(day.reservation.members)) : ""}"
                        style="${day.reservation ? reservationBackgroundStyle(day.reservation) : ""}"
                      >
                        <div class="calendar-day">${day.day}</div>
                        <div class="calendar-points">${day.points} pt</div>
                        <div class="calendar-status">
                          ${day.reservation ? memberLabel(day.reservation.members) : "Vrij"}
                        </div>
                        ${day.isToday ? `<div class="calendar-tag">Vandaag</div>` : ""}
                        ${day.isWeekend ? `<div class="calendar-tag">Weekend</div>` : ""}
                        ${day.holidayName ? `<div class="calendar-tag holiday-tag">${escapeHtml(day.holidayName)}</div>` : ""}
                      </button>
                      `}
                    `).join("")}
                  </div>
                </section>
              `).join("")}
            </div>
            </div>
            <form method="post" action="/planning/delete" id="planning-delete-form" style="display: none;">
              <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
              <input type="hidden" name="year" value="${selectedYear}">
              <input type="hidden" name="reservationId" id="planning-delete-id">
            </form>
          </section>
        </div>
        <aside class="planning-sidebar">
          <section class="card">
            <strong>Puntensysteem</strong>
            <p class="meta">Jan-mrt: 1 pt. Apr: 2 pt. Mei-sep: 4 pt. Okt: 2 pt. Nov-dec: 1 pt.</p>
            <p class="meta"> Klik op een bezette dag om die reservering te verwijderen. Bij annuleren gelden de annuleringspunten, tenzij het overmacht is.</p>
          </section>
          <section class="card">
            <strong>Gereserveerde punten</strong>
            <div style="display: grid; gap: 10px; margin-top: 14px;">
              ${memberTotals.map((item) => `
                <div style="display: flex; justify-content: space-between; gap: 12px; padding-bottom: 8px; border-bottom: 1px solid rgba(15, 47, 58, 0.08);">
                  <span style="display: inline-flex; align-items: center; gap: 8px;">
                    <span style="width: 12px; height: 12px; border-radius: 999px; background: ${memberColor(item.name)};"></span>
                    ${escapeHtml(item.name)}
                  </span>
                  <strong>${item.points.toFixed(2)}</strong>
                </div>
              `).join("")}
            </div>
          </section>
        </aside>
      </div>
      <section class="card" style="margin-top: 18px;">
        <strong>Annuleringen</strong>
        <div style="display: grid; gap: 10px; margin-top: 14px;">
          ${cancellations.length === 0 ? `<p class="meta">Nog geen annuleringen geregistreerd.</p>` : cancellations.map((item) => {
            const leadDays = cancellationLeadDays(item.startDate, item.cancelledAt);
            const leadText = leadDays === null ? "onbekend aantal dagen" : `${leadDays} dagen tevoren`;
            return `
              <div style="padding-bottom: 10px; border-bottom: 1px solid rgba(15, 47, 58, 0.08);">
                <strong>${memberLabel(item.members || [])}</strong>
                <p class="meta" style="margin: 6px 0 0;">Start reservering: ${escapeHtml(item.startDate || "onbekend")} | Geannuleerd: ${leadText}</p>
                <p class="meta" style="margin: 4px 0 0;">Verloren punten: ${Number(item.penaltyPoints || 0).toFixed(2)} | ${escapeHtml(item.ruleText || "")}</p>
              </div>
            `;
          }).join("")}
        </div>
      </section>
      <script>
        (() => {
          const buttons = Array.from(document.querySelectorAll('.calendar-cell[data-date]'));
          const startInput = document.getElementById('planning-start');
          const endInput = document.getElementById('planning-end');
          const selectionText = document.getElementById('planning-selection-text');
          const resetButton = document.getElementById('planning-reset');
          const deleteForm = document.getElementById('planning-delete-form');
          const deleteIdInput = document.getElementById('planning-delete-id');
          let startDate = null;
          let endDate = null;

          function updateSelectionText() {
            if (!startDate) {
              selectionText.textContent = 'Nog geen dagen geselecteerd.';
              return;
            }
            if (!endDate) {
              selectionText.textContent = 'Geselecteerde startdag: ' + startDate + '. Kies nu een einddag.';
              return;
            }
            selectionText.textContent = 'Geselecteerde periode: ' + startDate + ' t/m ' + endDate + '.';
          }

          function updateVisuals() {
            buttons.forEach((button) => {
              const date = button.dataset.date;
              button.classList.remove('selected', 'in-range');
              if (!startDate) {
                return;
              }
              if (date === startDate || date === endDate) {
                button.classList.add('selected');
                return;
              }
              if (endDate && date > startDate && date < endDate) {
                button.classList.add('in-range');
              }
            });
            startInput.value = startDate || '';
            endInput.value = endDate || '';
            updateSelectionText();
          }

          function resetSelection() {
            startDate = null;
            endDate = null;
            updateVisuals();
          }

          buttons.forEach((button) => {
            button.addEventListener('click', () => {
              if (button.dataset.reserved === 'true') {
                const reservationId = button.dataset.reservationId;
                const members = button.dataset.members || 'deze leden';
                if (reservationId && window.confirm('Reservering verwijderen voor ' + members + '?')) {
                  const overmacht = window.confirm('Is dit overmacht? Kies OK voor ja, Annuleren voor nee.');
                  deleteIdInput.value = reservationId;
                  let overmachtInput = deleteForm.querySelector('input[name="overmacht"]');
                  if (!overmachtInput) {
                    overmachtInput = document.createElement('input');
                    overmachtInput.type = 'hidden';
                    overmachtInput.name = 'overmacht';
                    deleteForm.appendChild(overmachtInput);
                  }
                  overmachtInput.value = overmacht ? 'true' : 'false';
                  deleteForm.submit();
                }
                return;
              }
              const date = button.dataset.date;
              if (!startDate || endDate) {
                startDate = date;
                endDate = null;
              } else if (date < startDate) {
                endDate = startDate;
                startDate = date;
              } else {
                endDate = date;
              }
              updateVisuals();
            });
          });

          resetButton.addEventListener('click', resetSelection);
          updateVisuals();
        })();
      </script>
    `,
  });
}

function zeildagenPage({ email, session }) {
  const data = session.pageData;
  const selectedYear = normalizePlanningYear(session.selectedYear);
  const overview = calculateSailingRightsOverview(data, selectedYear);
  const flash = takeFlash(session);
  const flashBlock = flash ? `<div class="notice ${escapeHtml(flash.type)}">${escapeHtml(flash.message)}</div>` : "";

  return baseLayout({
    title: "zeildagen | de Rederij",
    content: `
      <div class="top">
        <div>
          <h1>zeildagen</h1>
          <p>Beheer hier per lid het aantal aandelen. Het recht op zeildagen wordt automatisch berekend uit de reserveringen van dat jaar.</p>
        </div>
        <a class="back" href="/index.html">Terug naar home</a>
      </div>
      ${membersNav("/zeildagen")}
      ${flashBlock}
      <section class="card">
        <div class="year-toolbar">
          <div>
            <strong>Overzicht zeildagen</strong>
            <p class="meta" style="margin: 6px 0 0;">Totaal aantal geboekte zeilpunten in ${selectedYear} is ${overview.totalBookedPoints.toFixed(2).replace(".", ",")}.</p>
          </div>
          <div class="year-links">
            ${AVAILABLE_YEARS.map((year) => `
              <a class="back" href="/zeildagen?year=${year}" style="${year === selectedYear ? "background: #0f2f3a; color: white;" : ""}">${year}</a>
            `).join("")}
          </div>
        </div>
      </section>
      <section class="card" style="margin-top: 18px;">
        <strong>Aandelen per lid</strong>
        <p class="meta">Werkmodus als beheerder: vul per lid het aantal aandelen in. Per aandeel rekenen we ${SAILING_POINTS_PER_SHARE} zeilpunten recht. De verdeling van verbruikte punten volgt automatisch uit de planning.</p>
        <form method="post" action="/zeildagen" style="margin-top: 16px;">
          <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
          <input type="hidden" name="year" value="${selectedYear}">
          <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));">
            ${overview.rows.map((row) => `
              <div class="field">
                <label for="share-${escapeHtml(row.name)}" style="display: inline-flex; align-items: center; gap: 8px;">
                  <span style="width: 12px; height: 12px; border-radius: 999px; background: ${memberColor(row.name)};"></span>
                  ${escapeHtml(row.name)}
                </label>
                <input id="share-${escapeHtml(row.name)}" name="share_${escapeHtml(row.name)}" type="number" min="0" step="1" value="${row.shares}">
              </div>
            `).join("")}
          </div>
          <div class="actions">
            <button class="button" type="submit">Aandelen opslaan</button>
          </div>
        </form>
      </section>
      <section class="card" style="margin-top: 18px; overflow-x: auto;">
        <table style="width: 100%; min-width: 900px; border-collapse: collapse;">
          <thead>
            <tr>
              <th style="padding: 12px; text-align: left; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">Overzicht</th>
              ${overview.rows.map((row) => `
                <th style="padding: 12px; text-align: center; border-bottom: 1px solid rgba(15, 47, 58, 0.12); color: ${memberColor(row.name)};">${escapeHtml(row.name.toLowerCase())}</th>
              `).join("")}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style="padding: 12px; border-bottom: 1px solid rgba(15, 47, 58, 0.12);"><strong>zeilpunten verbruikt</strong></td>
              ${overview.rows.map((row) => `
                <td style="padding: 12px; text-align: center; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">${row.usedPoints.toFixed(2).replace(".", ",")}</td>
              `).join("")}
            </tr>
            <tr>
              <td style="padding: 12px; border-bottom: 1px solid rgba(15, 47, 58, 0.12);"><strong>aandelen</strong></td>
              ${overview.rows.map((row) => `
                <td style="padding: 12px; text-align: center; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">${row.shares}</td>
              `).join("")}
            </tr>
            <tr>
              <td style="padding: 12px; border-bottom: 1px solid rgba(15, 47, 58, 0.12);"><strong>zeilpunten recht</strong></td>
              ${overview.rows.map((row) => `
                <td style="padding: 12px; text-align: center; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">${row.entitledPoints.toFixed(0)}</td>
              `).join("")}
            </tr>
            <tr>
              <td style="padding: 12px;"><strong>zeilpunten over</strong></td>
              ${overview.rows.map((row) => `
                <td style="padding: 12px; text-align: center;">${row.remainingPoints.toFixed(2).replace(".", ",")}</td>
              `).join("")}
            </tr>
            <tr>
              <td style="padding: 12px; border-top: 1px solid rgba(15, 47, 58, 0.12);"><strong>zeildagen gevaren</strong></td>
              ${overview.rows.map((row) => `
                <td style="padding: 12px; text-align: center; border-top: 1px solid rgba(15, 47, 58, 0.12);">${row.sailedDays.toFixed(1).replace(".", ",")}</td>
              `).join("")}
            </tr>
          </tbody>
        </table>
      </section>
    `,
  });
}

function beheerSetupPage({ session, error = "" }) {
  const errorBlock = error ? `<div class="notice error">${escapeHtml(error)}</div>` : "";

  return baseLayout({
    title: "Beheer instellen | de Rederij",
    content: `
      <div class="top">
        <div>
          <h1>Beheer instellen</h1>
          <p>Maak hier het eerste beheerdersaccount aan. Alleen met dit account kun je de beheerpagina openen.</p>
        </div>
        <a class="back" href="/index.html">Terug naar home</a>
      </div>
      ${errorBlock}
      <section class="card">
        <form method="post" action="/beheer/setup">
          <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
          <div class="field">
            <label for="beheer-setup-email">E-mailadres</label>
            <input id="beheer-setup-email" name="email" type="email" placeholder="beheer@rederij.nl" required>
          </div>
          <div class="field">
            <label for="beheer-setup-password">Wachtwoord</label>
            <input id="beheer-setup-password" name="password" type="password" placeholder="Minimaal 12 tekens, hoofdletter, kleine letter en cijfer" required>
          </div>
          <button class="button" type="submit">Beheeraccount aanmaken</button>
        </form>
      </section>
    `,
  });
}

function beheerLoginPage({ session, error = "" }) {
  const errorBlock = error ? `<div class="notice error">${escapeHtml(error)}</div>` : "";

  return baseLayout({
    title: "Beheer login | de Rederij",
    content: `
      <div class="top">
        <div>
          <h1>Beheer login</h1>
          <p>Deze pagina is alleen bedoeld voor beheer van exports, aandelen en andere administratieve gegevens.</p>
        </div>
        <a class="back" href="/index.html">Terug naar home</a>
      </div>
      ${errorBlock}
      <section class="card">
        <form method="post" action="/beheer/login">
          <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
          <div class="field">
            <label for="beheer-login-email">E-mailadres</label>
            <input id="beheer-login-email" name="email" type="email" required>
          </div>
          <div class="field">
            <label for="beheer-login-password">Wachtwoord</label>
            <input id="beheer-login-password" name="password" type="password" required>
          </div>
          <div class="actions">
            <button class="button" type="submit">Inloggen</button>
          </div>
        </form>
      </section>
    `,
  });
}

function beheerDashboardPage({ session }) {
  const data = session.pageData;
  const selectedYear = normalizePlanningYear(session.selectedYear);
  const overview = calculateSailingRightsOverview(data, selectedYear);
  const generatedKasboek = calculateKasboekFromLogboek(data.logboekItems || []);
  const flash = takeFlash(session);
  const flashBlock = flash ? `<div class="notice ${escapeHtml(flash.type)}">${escapeHtml(flash.message)}</div>` : "";

  return baseLayout({
    title: "Beheer | de Rederij",
    content: `
      <div class="top">
        <div>
          <h1>Beheer</h1>
          <p>Hier beheer je de gegevens achter de schermen. Alleen beheerders kunnen deze pagina openen.</p>
        </div>
        <div class="actions">
          <a class="back" href="/index.html">Terug naar home</a>
          <a class="back" href="/beheer/logout">Uitloggen</a>
        </div>
      </div>
      ${flashBlock}
      <section class="card">
        <strong>Beheerfuncties</strong>
        <div class="grid">
          <a class="back" href="/planning" style="text-align: center;">Naar planning</a>
          <a class="back" href="/logboek" style="text-align: center;">Naar logboek</a>
          <a class="back" href="/informatie" style="text-align: center;">Naar informatie</a>
          <a class="back" href="/kasboek" style="text-align: center;">Naar kasboek</a>
        </div>
      </section>
      <section class="card" style="margin-top: 18px;">
        <div class="year-toolbar">
          <div>
            <strong>Zeildagen en aandelen</strong>
            <p class="meta" style="margin: 6px 0 0;">Totaal aantal geboekte zeilpunten in ${selectedYear}: ${overview.totalBookedPoints.toFixed(2).replace(".", ",")}.</p>
          </div>
          <div class="year-links">
            ${AVAILABLE_YEARS.map((year) => `
              <a class="back" href="/beheer?year=${year}" style="${year === selectedYear ? "background: #0f2f3a; color: white;" : ""}">${year}</a>
            `).join("")}
          </div>
        </div>
        <form method="post" action="/beheer/shares" style="margin-top: 16px;">
          <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
          <input type="hidden" name="year" value="${selectedYear}">
          <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));">
            ${overview.rows.map((row) => `
              <div class="field">
                <label for="beheer-share-${escapeHtml(row.name)}" style="display: inline-flex; align-items: center; gap: 8px;">
                  <span style="width: 12px; height: 12px; border-radius: 999px; background: ${memberColor(row.name)};"></span>
                  ${escapeHtml(row.name)}
                </label>
                <input id="beheer-share-${escapeHtml(row.name)}" name="share_${escapeHtml(row.name)}" type="number" min="0" step="1" value="${row.shares}">
              </div>
            `).join("")}
          </div>
          <div class="actions">
            <button class="button" type="submit">Aandelen opslaan</button>
            <a class="back" href="/zeildagen?year=${selectedYear}">Volledig overzicht bekijken</a>
          </div>
        </form>
      </section>
      <section class="card" style="margin-top: 18px;">
        <strong>Export naar Excel</strong>
        <p class="meta">De exportbestanden zijn CSV-bestanden. Die kun je direct openen in Excel voor filters, draaitabellen en overzichten.</p>
        <div class="grid">
          <a class="back" href="/beheer/export/logboek.csv">Logboek exporteren</a>
          <a class="back" href="/beheer/export/planning.csv">Planning exporteren</a>
          <a class="back" href="/beheer/export/kasboek.csv">Kasboek exporteren</a>
          <a class="back" href="/beheer/export/zeildagen.csv?year=${selectedYear}">Zeildagen exporteren</a>
        </div>
      </section>
      <section class="card" style="margin-top: 18px;">
        <strong>Kosten per lid uit logboek</strong>
        <p class="meta">Automatisch berekend vanuit definitieve logboektochten.</p>
        <div style="max-height: 430px; overflow: auto; margin-top: 12px;">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr>
              <th style="padding: 10px; text-align: left; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">Naam</th>
              <th style="padding: 10px; text-align: left; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">Bedrag</th>
            </tr>
          </thead>
          <tbody>
            ${generatedKasboek.memberRows.length === 0 ? `
              <tr><td colspan="2" style="padding: 10px;">Nog geen definitieve logboektochten om te berekenen.</td></tr>
            ` : generatedKasboek.memberRows.map((row, index) => `
              <tr>
                <td style="padding: 10px; ${index < generatedKasboek.memberRows.length - 1 ? "border-bottom: 1px solid rgba(15, 47, 58, 0.12);" : ""}">${escapeHtml(row.name)}</td>
                <td style="padding: 10px; ${index < generatedKasboek.memberRows.length - 1 ? "border-bottom: 1px solid rgba(15, 47, 58, 0.12);" : ""}">EUR ${row.amount.toFixed(2)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        </div>
      </section>
      <section class="card" style="margin-top: 18px;">
        <strong>Korte stand</strong>
        <div class="grid">
          <section class="card">
            <strong>Reserveringen</strong>
            <p>${(data.planningReservations || []).length}</p>
          </section>
          <section class="card">
            <strong>Logboekregels</strong>
            <p>${(data.logboekItems || []).length}</p>
          </section>
          <section class="card">
            <strong>Kasboekregels</strong>
            <p>${(data.kasboekItems || []).length}</p>
          </section>
        </div>
      </section>
    `,
  });
}

function latestMotorurenAankomst(items) {
  const sorted = (items || [])
    .slice()
    .sort((a, b) => {
      const dateCompare = String(b.datum || "").localeCompare(String(a.datum || ""));
      if (dateCompare !== 0) {
        return dateCompare;
      }
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });

  const latestItem = sorted.find((item) => String(item.motorurenAankomst || "").trim());
  return latestItem ? String(latestItem.motorurenAankomst).trim() : "";
}

function percentageFromLabel(value) {
  const match = String(value || "").match(/(\d{1,3})/);
  if (!match) {
    return 0;
  }
  const percentage = Number(match[1]);
  return Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0;
}

function latestVoorraadStatus(items) {
  const sorted = (items || [])
    .slice()
    .sort((a, b) => {
      const dateCompare = String(b.aankomstDatum || b.vertrekDatum || b.datum || "").localeCompare(String(a.aankomstDatum || a.vertrekDatum || a.datum || ""));
      if (dateCompare !== 0) {
        return dateCompare;
      }
      return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
    });

  const latestItem = sorted.find((item) => String(item.voorraadWater || item.voorraadDiesel || "").trim());
  return latestItem || null;
}

function logboekParticipants(item) {
  const names = [];

  if (String(item.schipper || "").trim()) {
    names.push(String(item.schipper || "").trim());
  }

  for (const part of String(item.opvarenden || "")
    .split(/[,;/\n]+/)
    .map((name) => name.trim())
    .filter(Boolean)) {
    names.push(part);
  }

  return [...new Set(names)];
}

function sailedDaysForLogboek(item) {
  const start = parseDateString(item.vertrekDatum || item.datum);
  const end = parseDateString(item.aankomstDatum || item.vertrekDatum || item.datum);
  if (!start || !end || end < start) {
    return 0;
  }
  return eachDateInRange(start, end).length;
}

function motorHoursForLogboek(item) {
  const start = Number(item.motorurenVertrek || 0);
  const end = Number(item.motorurenAankomst || 0);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return 0;
  }
  return end - start;
}

function calculateKasboekFromLogboek(logboekItems) {
  const finalItems = (logboekItems || [])
    .map((item) => normalizeLogboekItem(item))
    .filter((item) => item.status === "final");

  const memberTotals = new Map();
  const tripRows = [];

  for (const item of finalItems) {
    const participants = logboekParticipants(item);
    const sailedDays = sailedDaysForLogboek(item);
    const motorHours = motorHoursForLogboek(item);
    const dayCost = sailedDays * 5;
    const motorCost = motorHours * 5;
    const totalCost = dayCost + motorCost;
    const sharePerPerson = participants.length > 0 ? totalCost / participants.length : 0;

    for (const participant of participants) {
      memberTotals.set(participant, (memberTotals.get(participant) || 0) + sharePerPerson);
    }

    tripRows.push({
      vertrekDatum: item.vertrekDatum || item.datum || "",
      aankomstDatum: item.aankomstDatum || "",
      schipper: item.schipper || "",
      participants,
      sailedDays,
      motorHours,
      dayCost,
      motorCost,
      totalCost,
      sharePerPerson,
    });
  }

  const memberRows = Array.from(memberTotals.entries())
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => a.name.localeCompare(b.name, "nl-NL"));

  return {
    memberRows,
    tripRows,
    totalGenerated: tripRows.reduce((sum, row) => sum + row.totalCost, 0),
  };
}

function normalizeLogboekItem(item) {
  return {
    ...item,
    status: item.status === "draft" ? "draft" : "final",
    vertrekDatum: item.vertrekDatum || item.datum || "",
    aankomstDatum: item.aankomstDatum || "",
    windkracht: item.windkracht || "",
    motorurenVertrek: item.motorurenVertrek || "",
    motorurenAankomst: item.motorurenAankomst || "",
    route: item.route || "",
    havens: item.havens || "",
    schade: item.schade || item.notitie || "",
    schipper: item.schipper || "",
    opvarenden: item.opvarenden || item.bemanning || "",
    dieselIngenomen: item.dieselIngenomen || "",
    voorraadWater: item.voorraadWater || "",
    voorraadDiesel: item.voorraadDiesel || "",
  };
}

function logboekInputValue(value) {
  return escapeHtml(String(value || ""));
}

function logboekOptionList(options, selectedValue, placeholder) {
  return `
    <option value="">${escapeHtml(placeholder)}</option>
    ${options.map((option) => `
      <option value="${escapeHtml(option)}"${String(selectedValue || "") === String(option) ? " selected" : ""}>${escapeHtml(option)}</option>
    `).join("")}
  `;
}

function renderLogboekForm({ session, item, suggestedMotorurenVertrek, windOptions, voorraadOptions, action, submitLabel, secondaryLabel = "" }) {
  const values = normalizeLogboekItem(item || {});
  const isExisting = Boolean(values.id);

  return `
    <form method="post" action="${action}">
      <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
      ${isExisting ? `<input type="hidden" name="id" value="${escapeHtml(values.id)}">` : ""}
      <div class="card" style="background: rgba(15, 47, 58, 0.03);">
        <strong>Vertrek</strong>
        <div class="grid" style="margin-top: 14px;">
          <div class="field">
            <label>Vertrek datum</label>
            <input name="vertrekDatum" type="date" value="${logboekInputValue(values.vertrekDatum)}" required>
          </div>
          <div class="field">
            <label>Windkracht bij vertrek</label>
            <select name="windkracht" required>
              ${logboekOptionList(windOptions, values.windkracht, "Kies windkracht")}
            </select>
          </div>
          <div class="field">
            <label>Motoruren bij vertrek</label>
            <input name="motorurenVertrek" type="number" step="0.1" placeholder="1234.5" value="${logboekInputValue(values.motorurenVertrek || suggestedMotorurenVertrek)}" required>
          </div>
          <div class="field">
            <label>Gevaren route</label>
            <input name="route" type="text" placeholder="Colijnsplaat - Zierikzee - Colijnsplaat" value="${logboekInputValue(values.route)}" required>
          </div>
          <div class="field">
            <label>Schipper</label>
            <select name="schipper" required>
              ${logboekOptionList(MEMBER_NAMES, values.schipper, "Kies schipper")}
            </select>
          </div>
          <div class="field">
            <label>Opvarenden</label>
            <input name="opvarenden" type="text" placeholder="Namen opvarenden" value="${logboekInputValue(values.opvarenden)}">
          </div>
        </div>
      </div>
      <div class="card" style="background: rgba(15, 47, 58, 0.03);">
        <strong>Aankomst</strong>
        <div class="grid" style="margin-top: 14px;">
          <div class="field">
            <label>Aankomst datum</label>
            <input name="aankomstDatum" type="date" value="${logboekInputValue(values.aankomstDatum)}">
          </div>
          <div class="field">
            <label>Motoruren bij aankomst</label>
            <input name="motorurenAankomst" type="number" step="0.1" placeholder="1238.0" value="${logboekInputValue(values.motorurenAankomst)}">
          </div>
          <div class="field">
            <label>Aangedane havens</label>
            <input name="havens" type="text" placeholder="Zierikzee, Sint-Annaland" value="${logboekInputValue(values.havens)}">
          </div>
          <div class="field">
            <label>Eventuele schade of bijzonderheden</label>
            <textarea name="schade" placeholder="Geen schade, of noteer hier wat opgevallen is.">${logboekInputValue(values.schade)}</textarea>
          </div>
        </div>
      </div>
      <div class="card" style="background: rgba(15, 47, 58, 0.03);">
        <strong>Vloeistoffen</strong>
        <div class="grid" style="margin-top: 14px;">
          <div class="field">
            <label>Dieselolie ingenomen (liter)</label>
            <input name="dieselIngenomen" type="number" step="0.1" min="0" placeholder="0" value="${logboekInputValue(values.dieselIngenomen)}">
          </div>
          <div class="field">
            <label>Geschatte voorraad water bij vertrek van boord</label>
            <select name="voorraadWater" required>
              ${logboekOptionList(voorraadOptions, values.voorraadWater, "Kies percentage")}
            </select>
          </div>
          <div class="field">
            <label>Geschatte voorraad dieselolie bij vertrek van boord</label>
            <select name="voorraadDiesel" required>
              ${logboekOptionList(voorraadOptions, values.voorraadDiesel, "Kies percentage")}
            </select>
          </div>
        </div>
      </div>
      <div class="actions">
        <button class="button" type="submit" name="submitAction" value="draft">${escapeHtml(submitLabel)}</button>
        <button class="back" type="submit" name="submitAction" value="final">${escapeHtml(secondaryLabel || "Definitief opslaan")}</button>
      </div>
    </form>
  `;
}

function logboekPage({ email, session }) {
  const data = session.pageData;
  const items = (data.logboekItems || [])
    .map((item) => normalizeLogboekItem(item))
    .slice()
    .sort((a, b) => String(b.vertrekDatum || b.datum || "").localeCompare(String(a.vertrekDatum || a.datum || "")));
  const draftItems = items.filter((item) => item.status === "draft");
  const finalItems = items.filter((item) => item.status === "final");
  const suggestedMotorurenVertrek = latestMotorurenAankomst(items);
  const windOptions = Array.from({ length: 10 }, (_, index) => `${index} bft`);
  const voorraadOptions = Array.from({ length: 10 }, (_, index) => `${(index + 1) * 10}%`);
  const latestStatus = latestVoorraadStatus(items);
  const waterLevel = percentageFromLabel(latestStatus?.voorraadWater);
  const dieselLevel = percentageFromLabel(latestStatus?.voorraadDiesel);
  const flash = takeFlash(session);
  const flashBlock = flash ? `<div class="notice ${escapeHtml(flash.type)}">${escapeHtml(flash.message)}</div>` : "";

  return baseLayout({
    title: "logboek | de Rederij",
    content: `
      <div class="top">
        <div>
          <h1>logboek</h1>
          <p>Vul vertrek eerst als concept in, en werk de tocht later af met aankomstgegevens. Pas daarna sla je het logboek definitief op.</p>
        </div>
        <a class="back" href="/index.html">Terug naar home</a>
      </div>
      ${membersNav("/logboek")}
      ${flashBlock}
      <section class="card">
        <strong>Voorraad aan boord</strong>
        <p class="meta">Laatste bekende stand uit het logboek. Handig voor de volgende schipper voor vertrek.</p>
        <div class="grid" style="margin-top: 18px;">
          <section class="card" style="background: rgba(15, 47, 58, 0.03);">
            <strong>Water</strong>
            <div style="margin-top: 14px; height: 18px; border-radius: 999px; overflow: hidden; background: rgba(15, 47, 58, 0.08);">
              <div style="height: 100%; width: ${waterLevel}%; background: linear-gradient(90deg, #76b5c5 0%, #1d6072 100%);"></div>
            </div>
            <p style="margin: 12px 0 0; font-size: 1.4rem; font-weight: 700;">${latestStatus ? escapeHtml(latestStatus.voorraadWater || "Onbekend") : "Onbekend"}</p>
          </section>
          <section class="card" style="background: rgba(15, 47, 58, 0.03);">
            <strong>Diesel</strong>
            <div style="margin-top: 14px; height: 18px; border-radius: 999px; overflow: hidden; background: rgba(15, 47, 58, 0.08);">
              <div style="height: 100%; width: ${dieselLevel}%; background: linear-gradient(90deg, #d6a54b 0%, #8b5e3c 100%);"></div>
            </div>
            <p style="margin: 12px 0 0; font-size: 1.4rem; font-weight: 700;">${latestStatus ? escapeHtml(latestStatus.voorraadDiesel || "Onbekend") : "Onbekend"}</p>
          </section>
        </div>
      </section>
      <section class="card">
        <strong>Nieuwe tocht</strong>
        <p class="meta">Gebruik eerst concept opslaan bij vertrek. Vul later de aankomstgegevens aan en kies dan definitief opslaan.</p>
        ${renderLogboekForm({
          session,
          item: {},
          suggestedMotorurenVertrek,
          windOptions,
          voorraadOptions,
          action: "/logboek",
          submitLabel: "Concept opslaan",
          secondaryLabel: "Definitief opslaan",
        })}
      </section>
      <section class="card" style="margin-top: 18px;">
        <strong>Open concepten</strong>
        <div style="display: grid; gap: 16px; margin-top: 18px;">
          ${draftItems.length === 0 ? renderEmptyState("Er staan nu geen open concepten klaar.") : draftItems.map((item) => `
            <details class="card">
              <summary style="cursor: pointer; display: flex; justify-content: space-between; gap: 12px; align-items: center; font-weight: 700;">
                <span>${formatDate(item.vertrekDatum || item.datum)} | ${escapeHtml(item.schipper || "Onbekende schipper")}</span>
                <span class="meta">concept</span>
              </summary>
              <p class="meta" style="margin-top: 14px;">Werk deze tocht later af met aankomstgegevens en sla hem daarna definitief op.</p>
              ${renderLogboekForm({
                session,
                item,
                suggestedMotorurenVertrek,
                windOptions,
                voorraadOptions,
                action: "/logboek/update",
                submitLabel: "Concept bijwerken",
                secondaryLabel: "Definitief opslaan",
              })}
            </details>
          `).join("")}
        </div>
      </section>
      <section class="card" style="margin-top: 18px;">
        <strong>Definitief logboek</strong>
        <div style="display: grid; gap: 16px; margin-top: 18px;">
          ${finalItems.length === 0 ? renderEmptyState("Nog geen definitieve logboekregels toegevoegd.") : finalItems.map((item) => `
            <details class="card">
              <summary style="cursor: pointer; display: flex; justify-content: space-between; gap: 12px; align-items: center; font-weight: 700;">
                <span>${formatDate(item.vertrekDatum || item.datum)}${item.aankomstDatum ? ` t/m ${formatDate(item.aankomstDatum)}` : ""} | ${escapeHtml(item.schipper || "Onbekende schipper")}</span>
                <span class="meta">${escapeHtml(item.route || "Tocht")}</span>
              </summary>
              <div class="card" style="margin-top: 14px; background: rgba(15, 47, 58, 0.03);">
                <strong>Vertrek</strong>
                <div class="grid" style="margin-top: 14px;">
                  <p><b>Vertrek datum:</b> ${escapeHtml(item.vertrekDatum || item.datum || "-")}</p>
                  <p><b>Windkracht vertrek:</b> ${escapeHtml(item.windkracht || "-")}</p>
                  <p><b>Motoruren vertrek:</b> ${escapeHtml(item.motorurenVertrek || "-")}</p>
                  <p><b>Route:</b> ${escapeHtml(item.route || "-")}</p>
                  <p><b>Schipper:</b> ${escapeHtml(item.schipper || "-")}</p>
                  <p><b>Opvarenden:</b> ${escapeHtml(item.opvarenden || "-")}</p>
                </div>
              </div>
              <div class="card" style="margin-top: 14px; background: rgba(15, 47, 58, 0.03);">
                <strong>Aankomst</strong>
                <div class="grid" style="margin-top: 14px;">
                  <p><b>Aankomst datum:</b> ${escapeHtml(item.aankomstDatum || "-")}</p>
                  <p><b>Motoruren aankomst:</b> ${escapeHtml(item.motorurenAankomst || "-")}</p>
                  <p><b>Aangedane havens:</b> ${escapeHtml(item.havens || "-")}</p>
                  <p><b>Schade / bijzonderheden:</b> ${escapeHtml(item.schade || "Geen bijzonderheden.")}</p>
                </div>
              </div>
              <div class="card" style="margin-top: 14px; background: rgba(15, 47, 58, 0.03);">
                <strong>Vloeistoffen</strong>
                <div class="grid" style="margin-top: 14px;">
                  <p><b>Dieselolie ingenomen:</b> ${escapeHtml(item.dieselIngenomen || "0")} liter</p>
                  <p><b>Voorraad water vertrek boord:</b> ${escapeHtml(item.voorraadWater || "-")}</p>
                  <p><b>Voorraad diesel vertrek boord:</b> ${escapeHtml(item.voorraadDiesel || "-")}</p>
                </div>
              </div>
            </details>
          `).join("")}
        </div>
      </section>
    `,
  });
}

function informatiePage({ email, session }) {
  const info = session.pageData.informatie;

  return baseLayout({
    title: "informatie | de Rederij",
    content: `
      <div class="top">
        <div>
          <h1>informatie</h1>
          <p>Tijdelijke werkmodus zonder login voor het invullen van verenigingsinformatie.</p>
        </div>
        <a class="back" href="/index.html">Terug naar home</a>
      </div>
      ${membersNav("/informatie")}
      <section class="card">
        <strong>Informatie bijwerken</strong>
        <form method="post" action="/informatie">
          <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
          <div class="field">
            <label for="informatie-schip">Schip</label>
            <input id="informatie-schip" name="schip" type="text" value="${escapeHtml(info.schip)}" required>
          </div>
          <div class="field">
            <label for="informatie-veiligheid">Veiligheid</label>
            <input id="informatie-veiligheid" name="veiligheid" type="text" value="${escapeHtml(info.veiligheid)}" required>
          </div>
          <div class="field">
            <label for="informatie-contact">Contact</label>
            <input id="informatie-contact" name="contact" type="text" value="${escapeHtml(info.contact)}" required>
          </div>
          <button class="button" type="submit">Opslaan</button>
        </form>
      </section>
      <section class="card" style="margin-top: 18px;">
        <div class="grid">
          <section class="card">
            <strong>Schip</strong>
            ${escapeHtml(info.schip)}
          </section>
          <section class="card">
            <strong>Veiligheid</strong>
            ${escapeHtml(info.veiligheid)}
          </section>
          <section class="card">
            <strong>Contact</strong>
            ${escapeHtml(info.contact)}
          </section>
        </div>
      </section>
    `,
  });
}

function kasboekPage({ email, session }) {
  const items = session.pageData.kasboekItems
    .slice()
    .sort((a, b) => b.datum.localeCompare(a.datum));
  const totaal = items.reduce((sum, item) => sum + Number(item.bedrag), 0);
  const generated = calculateKasboekFromLogboek(session.pageData.logboekItems || []);

  return baseLayout({
    title: "kasboek | de Rederij",
    content: `
      <div class="top">
        <div>
          <h1>kasboek</h1>
          <p>Hier zie je zowel handmatige boekingen als automatisch berekende kosten uit het logboek.</p>
        </div>
        <a class="back" href="/index.html">Terug naar home</a>
      </div>
      ${membersNav("/kasboek")}
      <section class="card">
        <strong>Automatisch uit logboek</strong>
        <p class="meta">Per definitieve logboektocht rekenen we EUR 5 per gezeilde dag en EUR 5 per motoruur.</p>
        <p style="margin-top: 14px;"><b>Totaal automatisch berekend:</b> EUR ${generated.totalGenerated.toFixed(2)}</p>
      </section>
      <section class="card" style="margin-top: 18px;">
        <strong>Tochten en berekening</strong>
        <div style="max-height: 430px; overflow: auto; margin-top: 12px;">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr>
              <th style="padding: 10px; text-align: left; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">Periode</th>
              <th style="padding: 10px; text-align: left; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">Schipper</th>
              <th style="padding: 10px; text-align: left; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">Opvarenden</th>
              <th style="padding: 10px; text-align: left; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">Dagen</th>
              <th style="padding: 10px; text-align: left; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">Motoruren</th>
              <th style="padding: 10px; text-align: left; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">Totaal</th>
              <th style="padding: 10px; text-align: left; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">Per persoon</th>
            </tr>
          </thead>
          <tbody>
            ${generated.tripRows.length === 0 ? `
              <tr><td colspan="7" style="padding: 10px;">Nog geen definitieve logboektochten beschikbaar.</td></tr>
            ` : generated.tripRows.map((row, index) => `
              <tr>
                <td style="padding: 10px; ${index < generated.tripRows.length - 1 ? "border-bottom: 1px solid rgba(15, 47, 58, 0.12);" : ""}">${escapeHtml(row.vertrekDatum)}${row.aankomstDatum ? ` t/m ${escapeHtml(row.aankomstDatum)}` : ""}</td>
                <td style="padding: 10px; ${index < generated.tripRows.length - 1 ? "border-bottom: 1px solid rgba(15, 47, 58, 0.12);" : ""}">${escapeHtml(row.schipper || "-")}</td>
                <td style="padding: 10px; ${index < generated.tripRows.length - 1 ? "border-bottom: 1px solid rgba(15, 47, 58, 0.12);" : ""}">${escapeHtml(row.participants.join(", ") || "-")}</td>
                <td style="padding: 10px; ${index < generated.tripRows.length - 1 ? "border-bottom: 1px solid rgba(15, 47, 58, 0.12);" : ""}">${row.sailedDays} x EUR 5</td>
                <td style="padding: 10px; ${index < generated.tripRows.length - 1 ? "border-bottom: 1px solid rgba(15, 47, 58, 0.12);" : ""}">${row.motorHours.toFixed(1).replace(".", ",")} x EUR 5</td>
                <td style="padding: 10px; ${index < generated.tripRows.length - 1 ? "border-bottom: 1px solid rgba(15, 47, 58, 0.12);" : ""}">EUR ${row.totalCost.toFixed(2)}</td>
                <td style="padding: 10px; ${index < generated.tripRows.length - 1 ? "border-bottom: 1px solid rgba(15, 47, 58, 0.12);" : ""}">EUR ${row.sharePerPerson.toFixed(2)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        </div>
      </section>
      <section class="card">
        <strong>Nieuwe boeking</strong>
        <form method="post" action="/kasboek">
          <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
          <div class="grid">
            <div class="field">
              <label for="kasboek-datum">Datum</label>
              <input id="kasboek-datum" name="datum" type="date" required>
            </div>
            <div class="field">
              <label for="kasboek-naam">Naam lid</label>
              <select id="kasboek-naam" name="naam" required>
                <option value="">Kies lid</option>
                ${MEMBER_NAMES.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label for="kasboek-omschrijving">Omschrijving</label>
              <input id="kasboek-omschrijving" name="omschrijving" type="text" placeholder="Havengeld april" required>
            </div>
            <div class="field">
              <label for="kasboek-bedrag">Bedrag</label>
              <input id="kasboek-bedrag" name="bedrag" type="number" step="0.01" placeholder="25.00" required>
            </div>
          </div>
          <button class="button" type="submit">Boeking toevoegen</button>
        </form>
      </section>
      <section class="card" style="margin-top: 18px;">
        <p><b>Totaal handmatige boekingen:</b> EUR ${totaal.toFixed(2)}</p>
        <div style="max-height: 430px; overflow: auto; margin-top: 12px;">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr>
              <th style="padding: 12px; text-align: left; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">Datum</th>
              <th style="padding: 12px; text-align: left; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">Naam</th>
              <th style="padding: 12px; text-align: left; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">Omschrijving</th>
              <th style="padding: 12px; text-align: left; border-bottom: 1px solid rgba(15, 47, 58, 0.12);">Bedrag</th>
            </tr>
          </thead>
          <tbody>
            ${items.length === 0 ? `
              <tr>
                <td colspan="4" style="padding: 12px;">Nog geen boekingen toegevoegd.</td>
              </tr>
            ` : items.map((item, index) => `
              <tr>
                <td style="padding: 12px; ${index < items.length - 1 ? "border-bottom: 1px solid rgba(15, 47, 58, 0.12);" : ""}">${formatDate(item.datum)}</td>
                <td style="padding: 12px; ${index < items.length - 1 ? "border-bottom: 1px solid rgba(15, 47, 58, 0.12);" : ""}">${escapeHtml(item.naam || "-")}</td>
                <td style="padding: 12px; ${index < items.length - 1 ? "border-bottom: 1px solid rgba(15, 47, 58, 0.12);" : ""}">${escapeHtml(item.omschrijving)}</td>
                <td style="padding: 12px; ${index < items.length - 1 ? "border-bottom: 1px solid rgba(15, 47, 58, 0.12);" : ""}">EUR ${Number(item.bedrag).toFixed(2)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        </div>
      </section>
    `,
  });
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}

function setSecurityHeaders(res) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'self'; frame-ancestors 'none'");
}

async function serveStaticFile(res, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
  };

  try {
    const data = await fsp.readFile(filePath);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypes[extension] || "application/octet-stream");
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Niet gevonden");
      return;
    }
    throw error;
  }
}

function validateCsrf(session, form) {
  return form.csrfToken && session.csrfToken && form.csrfToken === session.csrfToken;
}

async function handleSetupGet(res, session) {
  redirect(res, "/planning");
}

async function handleSetupPost(req, res, session) {
  redirect(res, "/planning");
}

async function handleLoginGet(res, session) {
  redirect(res, "/planning");
}

async function handleLoginPost(req, res, session) {
  redirect(res, "/planning");
}

async function handleBeheerSetupGet(res, session) {
  const adminUser = await readAdminUser();
  if (adminUser) {
    redirect(res, "/beheer/login");
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(beheerSetupPage({ session }));
}

async function handleBeheerSetupPost(req, res, session) {
  const adminUser = await readAdminUser();
  if (adminUser) {
    redirect(res, "/beheer/login");
    return;
  }

  const form = parseForm(await collectBody(req));
  if (!validateCsrf(session, form)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Ongeldige aanvraag");
    return;
  }

  const email = normalizeEmail(form.email);
  const password = String(form.password || "");

  if (!isValidEmail(email)) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(beheerSetupPage({ session, error: "Vul een geldig e-mailadres in." }));
    return;
  }

  if (!isStrongPassword(password)) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(beheerSetupPage({ session, error: "Kies een sterk wachtwoord van minimaal 12 tekens met hoofdletter, kleine letter en cijfer." }));
    return;
  }

  const users = await readUsers();
  const passwordData = await hashPassword(password);
  users.push({
    id: createId(),
    email,
    role: "admin",
    ...passwordData,
    createdAt: new Date().toISOString(),
  });
  await writeUsers(users);
  session.adminEmail = email;
  session.userEmail = email;
  setFlash(session, "success", "Beheeraccount aangemaakt. Je bent nu ingelogd.");
  redirect(res, "/beheer");
}

async function handleBeheerLoginGet(res, session) {
  const adminUser = await readAdminUser();
  if (!adminUser) {
    redirect(res, "/beheer/setup");
    return;
  }

  if (isAdminAuthenticated(session)) {
    redirect(res, "/beheer");
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(beheerLoginPage({ session }));
}

async function handleBeheerLoginPost(req, res, session) {
  const adminUser = await readAdminUser();
  if (!adminUser) {
    redirect(res, "/beheer/setup");
    return;
  }

  const form = parseForm(await collectBody(req));
  if (!validateCsrf(session, form)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Ongeldige aanvraag");
    return;
  }

  const email = normalizeEmail(form.email);
  const password = String(form.password || "");
  const key = loginKey(req, email);

  if (isRateLimited(key)) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(beheerLoginPage({ session, error: "Te veel mislukte pogingen. Probeer het over een paar minuten opnieuw." }));
    return;
  }

  if (email !== normalizeEmail(adminUser.email) || !(await verifyPassword(password, adminUser))) {
    recordFailedAttempt(key);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(beheerLoginPage({ session, error: "Inloggen is niet gelukt." }));
    return;
  }

  clearFailedAttempts(key);
  session.adminEmail = adminUser.email;
  session.userEmail = adminUser.email;
  setFlash(session, "success", "Je bent ingelogd als beheerder.");
  redirect(res, "/beheer");
}

async function handleBeheer(req, res, session) {
  const adminUser = await readAdminUser();
  if (!adminUser) {
    redirect(res, "/beheer/setup");
    return;
  }

  if (!isAdminAuthenticated(session)) {
    redirect(res, "/beheer/login");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  session.selectedYear = normalizePlanningYear(url.searchParams.get("year"));
  session.pageData = await readAppData();
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(beheerDashboardPage({ session }));
}

async function handleBeheerSharesPost(req, res, session) {
  if (!isAdminAuthenticated(session)) {
    redirect(res, "/beheer/login");
    return;
  }

  const form = parseForm(await collectBody(req));
  if (!validateCsrf(session, form)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Ongeldige aanvraag");
    return;
  }

  const selectedYear = normalizePlanningYear(form.year);
  const data = await readAppData();
  const sharesByMember = { ...(data.sailingRightsShares || {}) };

  for (const name of MEMBER_NAMES) {
    const raw = String(form[`share_${name}`] || "").trim();
    const parsed = Number(raw);
    sharesByMember[name] = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
  }

  data.sailingRightsShares = sharesByMember;
  await writeAppData(data);
  setFlash(session, "success", "Aandelen zijn opgeslagen vanuit de beheerpagina.");
  redirect(res, `/beheer?year=${selectedYear}`);
}

async function handleBeheerExport(req, res, session, url) {
  if (!isAdminAuthenticated(session)) {
    redirect(res, "/beheer/login");
    return;
  }

  const data = await readAppData();
  const pathname = url.pathname;
  let csv = "";
  let fileName = "";

  if (pathname === "/beheer/export/logboek.csv") {
    csv = buildLogboekCsv(
      (data.logboekItems || [])
        .map((item) => normalizeLogboekItem(item))
        .filter((item) => item.status === "final")
        .slice()
        .sort((a, b) => String(a.vertrekDatum || a.datum || "").localeCompare(String(b.vertrekDatum || b.datum || ""))),
    );
    fileName = "logboek-export.csv";
  } else if (pathname === "/beheer/export/planning.csv") {
    csv = buildPlanningCsv((data.planningReservations || []).slice().sort((a, b) => String(a.startDate || "").localeCompare(String(b.startDate || ""))));
    fileName = "planning-export.csv";
  } else if (pathname === "/beheer/export/kasboek.csv") {
    csv = buildKasboekCsv((data.kasboekItems || []).slice().sort((a, b) => String(a.datum || "").localeCompare(String(b.datum || ""))));
    fileName = "kasboek-export.csv";
  } else if (pathname === "/beheer/export/zeildagen.csv") {
    const year = normalizePlanningYear(url.searchParams.get("year"));
    csv = buildZeildagenCsv(calculateSailingRightsOverview(data, year));
    fileName = `zeildagen-${year}.csv`;
  } else {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Niet gevonden");
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.end(csv);
}

async function handlePlanning(req, res, session) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  session.selectedYear = normalizePlanningYear(url.searchParams.get("year"));
  session.pageData = await readAppData();
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(planningPage({ email: "werkmodus", session }));
}

async function handleZeildagen(req, res, session) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  session.selectedYear = normalizePlanningYear(url.searchParams.get("year"));
  session.pageData = await readAppData();
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(zeildagenPage({ email: "werkmodus", session }));
}

async function handleProtectedPage(res, session, renderPage) {
  session.pageData = await readAppData();
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(renderPage({ email: "werkmodus", session }));
}

async function handlePlanningPost(req, res, session) {
  const form = parseForm(await collectBody(req));
  if (!validateCsrf(session, form)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Ongeldige aanvraag");
    return;
  }

  const startDate = String(form.startDate || "").trim();
  const endDate = String(form.endDate || "").trim();
  const selectedYear = normalizePlanningYear(form.year);
  const selectedMembers = Array.isArray(form.members)
    ? form.members
    : form.members
      ? [form.members]
      : [];
  const members = selectedMembers
    .map((name) => String(name).trim())
    .filter((name) => MEMBER_NAMES.includes(name));

  const start = parseDateString(startDate);
  const end = parseDateString(endDate);
  if (!start || !end || start > end || members.length === 0) {
    setFlash(session, "error", "Kies een geldige begin- en einddag in de kalender en vink minimaal 1 lid aan.");
    redirect(res, `/planning?year=${selectedYear}`);
    return;
  }

  const data = await readAppData();
  const conflict = findReservationConflict(data.planningReservations, startDate, endDate);
  if (conflict) {
    setFlash(
      session,
      "error",
      `Deze reservering botst op ${conflict.conflictDate} met ${conflict.reservation.members.join(", ")}. De eerste reservering houdt voorrang.`,
    );
    redirect(res, `/planning?year=${selectedYear}`);
    return;
  }

  const points = getPointsForRange(startDate, endDate);
  data.planningReservations.push({
    id: createId(),
    startDate,
    endDate,
    members,
    purpose: "Reservering",
    notes: "",
    points: points.totalPoints,
    createdBy: "werkmodus",
    createdAt: new Date().toISOString(),
  });
  await writeAppData(data);
  setFlash(session, "success", `Reservering opgeslagen voor ${members.join(", ")}. Totaal aantal punten: ${points.totalPoints}.`);
  redirect(res, `/planning?year=${selectedYear}`);
}

async function handlePlanningDelete(req, res, session) {
  const form = parseForm(await collectBody(req));
  if (!validateCsrf(session, form)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Ongeldige aanvraag");
    return;
  }

  const reservationId = String(form.reservationId || "").trim();
  const overmacht = String(form.overmacht || "").trim() === "true";
  const selectedYear = normalizePlanningYear(form.year);
  if (!reservationId) {
    redirect(res, `/planning?year=${selectedYear}`);
    return;
  }

  const data = await readAppData();
  const reservation = data.planningReservations.find((item) => item.id === reservationId);
  const beforeCount = data.planningReservations.length;
  data.planningReservations = data.planningReservations.filter((reservation) => reservation.id !== reservationId);

  if (reservation && data.planningReservations.length < beforeCount) {
    const penalty = cancellationPenaltyForReservation(reservation, overmacht);
    data.cancellationPenalties.push({
      id: createId(),
      reservationId: reservation.id,
      members: reservation.members,
      startDate: reservation.startDate,
      penaltyPoints: penalty.penaltyPoints,
      ruleText: penalty.ruleText,
      overmacht,
      cancelledAt: new Date().toISOString(),
    });
    await writeAppData(data);
    setFlash(
      session,
      "success",
      `Reservering verwijderd. ${penalty.ruleText} Verloren punten: ${penalty.penaltyPoints.toFixed(2)}.`,
    );
  } else {
    await writeAppData(data);
    setFlash(session, "error", "Reservering niet gevonden.");
  }

  redirect(res, `/planning?year=${selectedYear}`);
}

async function handleLogboekPost(req, res, session) {
  const form = parseForm(await collectBody(req));
  if (!validateCsrf(session, form)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Ongeldige aanvraag");
    return;
  }

  const submitAction = String(form.submitAction || "draft").trim() === "final" ? "final" : "draft";
  const vertrekDatum = String(form.vertrekDatum || "").trim();
  const aankomstDatum = String(form.aankomstDatum || "").trim();
  const windkracht = String(form.windkracht || "").trim();
  const motorurenVertrek = String(form.motorurenVertrek || "").trim();
  const motorurenAankomst = String(form.motorurenAankomst || "").trim();
  const route = String(form.route || "").trim();
  const schipper = String(form.schipper || "").trim();
  const voorraadWater = String(form.voorraadWater || "").trim();
  const voorraadDiesel = String(form.voorraadDiesel || "").trim();
  const hasDepartureBasics = vertrekDatum && windkracht && motorurenVertrek && route && schipper && voorraadWater && voorraadDiesel;
  const hasArrivalBasics = aankomstDatum && motorurenAankomst;

  if (!hasDepartureBasics || (submitAction === "final" && !hasArrivalBasics)) {
    redirect(res, "/logboek");
    return;
  }

  const data = await readAppData();
  data.logboekItems.push({
    id: createId(),
    datum: vertrekDatum,
    vertrekDatum,
    aankomstDatum,
    windkracht,
    motorurenVertrek,
    motorurenAankomst,
    route,
    havens: String(form.havens || "").trim(),
    schade: String(form.schade || "").trim(),
    schipper,
    opvarenden: String(form.opvarenden || "").trim(),
    dieselIngenomen: String(form.dieselIngenomen || "").trim(),
    voorraadWater,
    voorraadDiesel,
    status: submitAction === "final" ? "final" : "draft",
    createdAt: new Date().toISOString(),
    createdBy: "werkmodus",
  });
  await writeAppData(data);
  setFlash(session, "success", submitAction === "final" ? "Logboekregel definitief opgeslagen." : "Concept opgeslagen. Je kunt de aankomst later aanvullen.");
  redirect(res, "/logboek");
}

async function handleLogboekUpdatePost(req, res, session) {
  const form = parseForm(await collectBody(req));
  if (!validateCsrf(session, form)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Ongeldige aanvraag");
    return;
  }

  const id = String(form.id || "").trim();
  const submitAction = String(form.submitAction || "draft").trim() === "final" ? "final" : "draft";
  if (!id) {
    redirect(res, "/logboek");
    return;
  }

  const vertrekDatum = String(form.vertrekDatum || "").trim();
  const aankomstDatum = String(form.aankomstDatum || "").trim();
  const windkracht = String(form.windkracht || "").trim();
  const motorurenVertrek = String(form.motorurenVertrek || "").trim();
  const motorurenAankomst = String(form.motorurenAankomst || "").trim();
  const route = String(form.route || "").trim();
  const schipper = String(form.schipper || "").trim();
  const voorraadWater = String(form.voorraadWater || "").trim();
  const voorraadDiesel = String(form.voorraadDiesel || "").trim();
  const hasDepartureBasics = vertrekDatum && windkracht && motorurenVertrek && route && schipper && voorraadWater && voorraadDiesel;
  const hasArrivalBasics = aankomstDatum && motorurenAankomst;

  if (!hasDepartureBasics || (submitAction === "final" && !hasArrivalBasics)) {
    setFlash(session, "error", submitAction === "final" ? "Vul ook de aankomst datum en motoruren bij aankomst in om definitief op te slaan." : "Vul eerst de vertrekgegevens volledig in.");
    redirect(res, "/logboek");
    return;
  }

  const data = await readAppData();
  const item = (data.logboekItems || []).find((entry) => entry.id === id);
  if (!item) {
    setFlash(session, "error", "Concept niet gevonden.");
    redirect(res, "/logboek");
    return;
  }

  Object.assign(item, {
    datum: vertrekDatum,
    vertrekDatum,
    aankomstDatum,
    windkracht,
    motorurenVertrek,
    motorurenAankomst,
    route,
    havens: String(form.havens || "").trim(),
    schade: String(form.schade || "").trim(),
    schipper,
    opvarenden: String(form.opvarenden || "").trim(),
    dieselIngenomen: String(form.dieselIngenomen || "").trim(),
    voorraadWater,
    voorraadDiesel,
    status: submitAction === "final" ? "final" : "draft",
    updatedAt: new Date().toISOString(),
  });

  await writeAppData(data);
  setFlash(session, "success", submitAction === "final" ? "Concept is definitief opgeslagen." : "Concept bijgewerkt.");
  redirect(res, "/logboek");
}

async function handleZeildagenPost(req, res, session) {
  const form = parseForm(await collectBody(req));
  if (!validateCsrf(session, form)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Ongeldige aanvraag");
    return;
  }

  const selectedYear = normalizePlanningYear(form.year);
  const data = await readAppData();
  const sharesByMember = { ...(data.sailingRightsShares || {}) };

  for (const name of MEMBER_NAMES) {
    const raw = String(form[`share_${name}`] || "").trim();
    const parsed = Number(raw);
    sharesByMember[name] = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
  }

  data.sailingRightsShares = sharesByMember;
  await writeAppData(data);
  setFlash(session, "success", "Aandelen per lid zijn opgeslagen.");
  redirect(res, `/zeildagen?year=${selectedYear}`);
}

async function handleInformatiePost(req, res, session) {
  const form = parseForm(await collectBody(req));
  if (!validateCsrf(session, form)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Ongeldige aanvraag");
    return;
  }

  const data = await readAppData();
  data.informatie = {
    schip: String(form.schip || "").trim(),
    veiligheid: String(form.veiligheid || "").trim(),
    contact: String(form.contact || "").trim(),
  };
  await writeAppData(data);
  redirect(res, "/informatie");
}

async function handleKasboekPost(req, res, session) {
  const form = parseForm(await collectBody(req));
  if (!validateCsrf(session, form)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Ongeldige aanvraag");
    return;
  }

  const datum = String(form.datum || "").trim();
  const naam = String(form.naam || "").trim();
  const omschrijving = String(form.omschrijving || "").trim();
  const bedrag = Number(form.bedrag);

  if (!datum || !naam || !omschrijving || Number.isNaN(bedrag)) {
    redirect(res, "/kasboek");
    return;
  }

  const data = await readAppData();
  data.kasboekItems.push({
    id: createId(),
    datum,
    naam,
    omschrijving,
    bedrag,
    createdBy: "werkmodus",
  });
  await writeAppData(data);
  redirect(res, "/kasboek");
}

async function handleLogout(req, res, session) {
  redirect(res, "/planning");
}

const server = http.createServer(async (req, res) => {
  try {
    setSecurityHeaders(res);

    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const session = getSession(req, res);

    if (req.method === "GET" && url.pathname === "/") {
      await serveStaticFile(res, path.join(ROOT, "index.html"));
      return;
    }

    if (req.method === "GET" && url.pathname === "/setup") {
      await handleSetupGet(res, session);
      return;
    }

    if (req.method === "POST" && url.pathname === "/setup") {
      await handleSetupPost(req, res, session);
      return;
    }

    if (req.method === "GET" && url.pathname === "/login") {
      await handleLoginGet(res, session);
      return;
    }

    if (req.method === "POST" && url.pathname === "/login") {
      await handleLoginPost(req, res, session);
      return;
    }

    if (req.method === "GET" && url.pathname === "/beheer/setup") {
      await handleBeheerSetupGet(res, session);
      return;
    }

    if (req.method === "POST" && url.pathname === "/beheer/setup") {
      await handleBeheerSetupPost(req, res, session);
      return;
    }

    if (req.method === "GET" && url.pathname === "/beheer/login") {
      await handleBeheerLoginGet(res, session);
      return;
    }

    if (req.method === "POST" && url.pathname === "/beheer/login") {
      await handleBeheerLoginPost(req, res, session);
      return;
    }

    if (req.method === "GET" && url.pathname === "/beheer/logout") {
      delete session.adminEmail;
      delete session.userEmail;
      redirect(res, "/beheer/login");
      return;
    }

    if (req.method === "GET" && url.pathname === "/beheer") {
      await handleBeheer(req, res, session);
      return;
    }

    if (req.method === "GET" && url.pathname === "/planning") {
      await handlePlanning(req, res, session);
      return;
    }

    if (req.method === "GET" && url.pathname === "/zeildagen") {
      await handleZeildagen(req, res, session);
      return;
    }

    if (req.method === "POST" && url.pathname === "/planning") {
      await handlePlanningPost(req, res, session);
      return;
    }

    if (req.method === "POST" && url.pathname === "/zeildagen") {
      await handleZeildagenPost(req, res, session);
      return;
    }

    if (req.method === "POST" && url.pathname === "/beheer/shares") {
      await handleBeheerSharesPost(req, res, session);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/beheer/export/")) {
      await handleBeheerExport(req, res, session, url);
      return;
    }

    if (req.method === "POST" && url.pathname === "/planning/delete") {
      await handlePlanningDelete(req, res, session);
      return;
    }

    if (req.method === "GET" && url.pathname === "/logboek") {
      await handleProtectedPage(res, session, logboekPage);
      return;
    }

    if (req.method === "POST" && url.pathname === "/logboek") {
      await handleLogboekPost(req, res, session);
      return;
    }

    if (req.method === "POST" && url.pathname === "/logboek/update") {
      await handleLogboekUpdatePost(req, res, session);
      return;
    }

    if (req.method === "GET" && url.pathname === "/informatie") {
      await handleProtectedPage(res, session, informatiePage);
      return;
    }

    if (req.method === "POST" && url.pathname === "/informatie") {
      await handleInformatiePost(req, res, session);
      return;
    }

    if (req.method === "GET" && url.pathname === "/kasboek") {
      await handleProtectedPage(res, session, kasboekPage);
      return;
    }

    if (req.method === "POST" && url.pathname === "/kasboek") {
      await handleKasboekPost(req, res, session);
      return;
    }

    if (req.method === "GET" && url.pathname === "/planning.html") {
      redirect(res, "/planning");
      return;
    }

    if (req.method === "GET" && url.pathname === "/logboek.html") {
      redirect(res, "/logboek");
      return;
    }

    if (req.method === "GET" && url.pathname === "/informatie.html") {
      redirect(res, "/informatie");
      return;
    }

    if (req.method === "GET" && url.pathname === "/kasboek.html") {
      redirect(res, "/kasboek");
      return;
    }

    if (req.method === "POST" && url.pathname === "/logout") {
      await handleLogout(req, res, session);
      return;
    }

    if (req.method === "GET") {
      if (url.pathname === "/server.js" || url.pathname.startsWith("/data/")) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Niet toegestaan");
        return;
      }

      const requestedPath = path.normalize(path.join(ROOT, url.pathname));
      if (!requestedPath.startsWith(ROOT)) {
        res.statusCode = 403;
        res.end("Niet toegestaan");
        return;
      }
      await serveStaticFile(res, requestedPath);
      return;
    }

    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Methode niet toegestaan");
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Er ging iets mis op de server.");
    console.error(error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`de Rederij draait op http://${HOST}:${PORT}`);
});
