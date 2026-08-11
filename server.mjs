import { createServer } from "node:http";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const scrypt = promisify(scryptCallback);
const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const dataDirectory = resolve(process.env.DATA_DIR || join(root, "data"));
const dataFile = join(dataDirectory, "questboard.json");
const maxBodyBytes = 5 * 1024 * 1024;
const sessionMaxAgeSeconds = 30 * 24 * 60 * 60;
const DEFAULT_ADMIN_PIN = "1234";
const DEFAULT_PLAYER_PIN = "0000";
const PIN_PATTERN = /^\d{4,8}$/;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

let record;
let writeQueue = Promise.resolve();
const sessions = new Map();
const loginAttempts = new Map();

function makeId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function shiftedDate(date, minutesAgo) {
  return new Date(date.getTime() + minutesAgo * 60_000);
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function periodKeys(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const dayKey = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  const monthKey = `${parts.year}-${pad2(parts.month)}`;
  const utcDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const dayOfWeek = utcDay.getUTCDay() || 7;
  utcDay.setUTCDate(utcDay.getUTCDate() - dayOfWeek + 1);
  const weekKey = utcDay.toISOString().slice(0, 10);
  return { dayKey, weekKey, monthKey };
}

function periodProperty(frequency) {
  return frequency === "weekly" ? "weekKey" : frequency === "monthly" ? "monthKey" : "dayKey";
}

function createCompletion(task, date, timeZone) {
  const keys = periodKeys(date, timeZone);
  return {
    id: makeId("completion"),
    taskId: task.id,
    userId: task.userId,
    taskTitle: task.title,
    xp: task.xp,
    frequency: task.frequency,
    completedAt: date.toISOString(),
    ...keys,
    periodKey: keys[periodProperty(task.frequency)]
  };
}

function createSeedState() {
  const createdAt = new Date().toISOString();
  const timezone = "Europe/London";
  const users = [
    { id: "user-parent", name: "Parent", avatar: "🛡️", colour: "#5038c8", role: "admin", createdAt },
    { id: "user-mia", name: "Mia", avatar: "🦊", colour: "#6d5dfc", role: "player", createdAt },
    { id: "user-leo", name: "Leo", avatar: "🐯", colour: "#f28b42", role: "player", createdAt },
    { id: "user-ava", name: "Ava", avatar: "🐼", colour: "#2f9d77", role: "player", createdAt }
  ];
  const tasks = [
    { id: "task-mia-bed", userId: "user-mia", title: "Make the bed", description: "Duvet straight and pillows in place", frequency: "daily", xp: 10, active: true, createdAt },
    { id: "task-mia-teeth", userId: "user-mia", title: "Evening teeth", description: "Brush for two minutes before bed", frequency: "daily", xp: 10, active: true, createdAt },
    { id: "task-mia-laundry", userId: "user-mia", title: "Put laundry away", description: "Fold it and place it in the right drawers", frequency: "weekly", xp: 35, active: true, createdAt },
    { id: "task-mia-room", userId: "user-mia", title: "Bedroom reset", description: "Clear surfaces and tidy the floor", frequency: "monthly", xp: 80, active: true, createdAt },
    { id: "task-leo-cat", userId: "user-leo", title: "Feed the cat", description: "Fresh food and clean water", frequency: "daily", xp: 15, active: true, createdAt },
    { id: "task-leo-bag", userId: "user-leo", title: "Pack school bag", description: "Books, homework and water bottle", frequency: "daily", xp: 10, active: true, createdAt },
    { id: "task-leo-recycling", userId: "user-leo", title: "Help with recycling", description: "Sort paper, cans and plastic", frequency: "weekly", xp: 40, active: true, createdAt },
    { id: "task-leo-bike", userId: "user-leo", title: "Clean the bike", description: "Wipe the frame and check the tyres", frequency: "monthly", xp: 75, active: true, createdAt },
    { id: "task-ava-plate", userId: "user-ava", title: "Clear breakfast plate", description: "Take dishes to the kitchen", frequency: "daily", xp: 10, active: true, createdAt },
    { id: "task-ava-read", userId: "user-ava", title: "Read for 20 minutes", description: "Choose any book and settle somewhere quiet", frequency: "daily", xp: 20, active: true, createdAt },
    { id: "task-ava-plants", userId: "user-ava", title: "Water the plants", description: "Check the soil before watering", frequency: "weekly", xp: 30, active: true, createdAt },
    { id: "task-ava-toys", userId: "user-ava", title: "Sort the toy shelf", description: "Return everything to its labelled box", frequency: "monthly", xp: 70, active: true, createdAt }
  ];
  const rewards = [
    { id: "reward-dessert", title: "Choose Friday's dessert", description: "Pick the family dessert for Friday evening.", icon: "🍨", threshold: 100, active: true, createdAt },
    { id: "reward-movie", title: "Choose movie night", description: "Choose the film for the next family movie night.", icon: "🎬", threshold: 250, active: true, createdAt },
    { id: "reward-adventure", title: "Plan a family adventure", description: "Choose a weekend activity for the family.", icon: "🗺️", threshold: 500, active: true, createdAt }
  ];
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const now = new Date();
  const completionSpecs = [
    ["task-mia-bed", -90],
    ["task-mia-laundry", -70],
    ["task-leo-cat", -130],
    ["task-leo-bag", -110],
    ["task-ava-plate", -150],
    ["task-ava-read", -100],
    ["task-ava-plants", -75],
    ["task-mia-teeth", -(24 * 60 + 40)],
    ["task-leo-cat", -(24 * 60 + 80)],
    ["task-ava-plate", -(24 * 60 + 100)]
  ];
  const completions = completionSpecs.map(([taskId, offset]) => (
    createCompletion(taskMap.get(taskId), shiftedDate(now, offset), timezone)
  ));
  return { version: 4, timezone, streakResetMonthly: false, users, tasks, rewards, completions };
}

function cleanText(value, maximum, fallback = "") {
  return String(value ?? fallback).trim().slice(0, maximum);
}

function ensureAdminUser(users) {
  if (users.some((user) => user.role === "admin")) return users;

  const createdAt = new Date().toISOString();
  const id = users.some((user) => user.id === "user-parent") ? makeId("user-admin") : "user-parent";
  return [
    { id, name: "Parent", avatar: "🛡️", colour: "#5038c8", role: "admin", createdAt },
    ...users
  ];
}

function normaliseState(candidate) {
  if (!candidate || typeof candidate !== "object") throw new Error("Missing Questboard state");
  const timezone = cleanText(candidate.timezone, 100, "Europe/London") || "Europe/London";
  const streakResetMonthly = candidate.streakResetMonthly === true;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone }).format();
  } catch {
    throw new Error("Invalid timezone");
  }

  const mappedUsers = Array.isArray(candidate.users) ? candidate.users.slice(0, 100).map((user) => ({
    id: cleanText(user?.id, 100),
    name: cleanText(user?.name, 24, "Player") || "Player",
    avatar: cleanText(user?.avatar, 8, "⭐") || "⭐",
    colour: /^#[0-9a-f]{6}$/i.test(String(user?.colour || "")) ? user.colour : "#6d5dfc",
    role: user?.role === "admin" || user?.id === "user-parent" ? "admin" : "player",
    createdAt: cleanText(user?.createdAt, 40, new Date().toISOString())
  })).filter((user) => user.id) : [];
  if (!mappedUsers.length) throw new Error("At least one player is required");
  const users = ensureAdminUser(mappedUsers);

  const userIds = new Set(users.map((user) => user.id));
  const tasks = Array.isArray(candidate.tasks) ? candidate.tasks.slice(0, 5000).map((task) => ({
    id: cleanText(task?.id, 100),
    userId: cleanText(task?.userId, 100),
    title: cleanText(task?.title, 60, "Untitled quest") || "Untitled quest",
    description: cleanText(task?.description, 160),
    frequency: ["daily", "weekly", "monthly"].includes(task?.frequency) ? task.frequency : "daily",
    xp: Math.min(500, Math.max(1, Math.round(Number(task?.xp) || 10))),
    active: task?.active !== false,
    createdAt: cleanText(task?.createdAt, 40, new Date().toISOString()),
    ...(task?.updatedAt ? { updatedAt: cleanText(task.updatedAt, 40) } : {})
  })).filter((task) => task.id && userIds.has(task.userId)) : [];

  const rewards = Array.isArray(candidate.rewards) ? candidate.rewards.slice(0, 1000).map((reward) => ({
    id: cleanText(reward?.id, 100),
    title: cleanText(reward?.title, 60, "Untitled reward") || "Untitled reward",
    description: cleanText(reward?.description, 160),
    icon: cleanText(reward?.icon, 8, "🎁") || "🎁",
    threshold: Math.min(1_000_000, Math.max(1, Math.round(Number(reward?.threshold) || 100))),
    active: reward?.active !== false,
    createdAt: cleanText(reward?.createdAt, 40, new Date().toISOString()),
    ...(reward?.updatedAt ? { updatedAt: cleanText(reward.updatedAt, 40) } : {})
  })).filter((reward) => reward.id) : [];

  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const completions = Array.isArray(candidate.completions) ? candidate.completions.slice(-100000).map((completion) => {
    const userId = cleanText(completion?.userId, 100);
    if (!cleanText(completion?.id, 100) || !userIds.has(userId)) return null;
    const completedAt = new Date(completion?.completedAt);
    if (Number.isNaN(completedAt.getTime())) return null;
    const task = taskMap.get(completion?.taskId);
    const frequency = ["daily", "weekly", "monthly"].includes(completion?.frequency)
      ? completion.frequency
      : task?.frequency || "daily";
    const keys = periodKeys(completedAt, timezone);
    return {
      id: cleanText(completion.id, 100),
      taskId: cleanText(completion?.taskId, 100, "deleted-task") || "deleted-task",
      userId,
      taskTitle: cleanText(completion?.taskTitle, 60, task?.title || "Completed quest") || "Completed quest",
      xp: Math.max(0, Math.round(Number(completion?.xp) || 0)),
      frequency,
      completedAt: completedAt.toISOString(),
      ...keys,
      periodKey: keys[periodProperty(frequency)]
    };
  }).filter(Boolean) : [];

  return { version: 4, timezone, streakResetMonthly, users, tasks, rewards, completions };
}

async function hashPin(pin) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await scrypt(pin, salt, 32);
  return { salt, hash: Buffer.from(derivedKey).toString("hex") };
}

async function verifyPin(pin, credentials) {
  if (!credentials?.salt || !credentials?.hash) return false;
  const expected = Buffer.from(credentials.hash, "hex");
  if (expected.length !== 32) return false;
  const actual = Buffer.from(await scrypt(pin, credentials.salt, 32));
  return timingSafeEqual(actual, expected);
}

async function normaliseAuth(candidate, users) {
  const auth = {};
  for (const user of users) {
    const existing = candidate?.[user.id];
    if (existing && /^[0-9a-f]{32}$/i.test(String(existing.salt || "")) && /^[0-9a-f]{64}$/i.test(String(existing.hash || ""))) {
      auth[user.id] = { salt: existing.salt, hash: existing.hash };
    } else {
      auth[user.id] = await hashPin(user.role === "admin" ? DEFAULT_ADMIN_PIN : DEFAULT_PLAYER_PIN);
    }
  }
  return auth;
}

async function writeRecord(nextRecord) {
  const temporaryFile = `${dataFile}.${process.pid}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(nextRecord, null, 2)}\n`, "utf8");
  await rename(temporaryFile, dataFile);
  record = nextRecord;
  return record;
}

async function persist(nextState, nextAuth = record?.auth) {
  const operation = writeQueue.catch(() => undefined).then(async () => {
    const state = normaliseState(nextState);
    const auth = await normaliseAuth(nextAuth, state.users);
    return writeRecord({
      revision: (record?.revision || 0) + 1,
      updatedAt: new Date().toISOString(),
      state,
      auth
    });
  });
  writeQueue = operation;
  return operation;
}

async function persistAtRevision(baseRevision, nextState) {
  const operation = writeQueue.catch(() => undefined).then(async () => {
    if (baseRevision !== record.revision) return { conflict: true, record };
    const state = normaliseState(nextState);
    const auth = await normaliseAuth(record.auth, state.users);
    const nextRecord = {
      revision: record.revision + 1,
      updatedAt: new Date().toISOString(),
      state,
      auth
    };
    await writeRecord(nextRecord);
    return { conflict: false, record: nextRecord };
  });
  writeQueue = operation;
  return operation;
}

async function initialiseStore() {
  await mkdir(dataDirectory, { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(dataFile, "utf8"));
    const state = normaliseState(parsed.state || parsed);
    const auth = await normaliseAuth(parsed.auth, state.users);
    const nextRecord = {
      revision: Math.max(1, Number(parsed.revision) || 1),
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      state,
      auth
    };
    await writeRecord(nextRecord);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`Could not read ${dataFile}; creating a fresh store:`, error.message);
    }
    record = { revision: 0, updatedAt: new Date().toISOString(), state: createSeedState(), auth: {} };
    await persist(record.state, record.auth);
  }
}

function parseCookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function getSession(request) {
  const token = parseCookies(request).questboard_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) sessions.delete(token);
    return null;
  }
  const user = record.state.users.find((candidate) => candidate.id === session.userId);
  if (!user) {
    sessions.delete(token);
    return null;
  }
  return { token, user };
}

function requireSession(request) {
  const session = getSession(request);
  if (!session) {
    const error = new Error("Enter a profile PIN first.");
    error.statusCode = 401;
    throw error;
  }
  return session;
}

function requireAdmin(request) {
  const session = requireSession(request);
  if (session.user.role !== "admin") {
    const error = new Error("Admin access is required.");
    error.statusCode = 403;
    throw error;
  }
  return session;
}

function cookieHeader(request, token, maxAge = sessionMaxAgeSeconds) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const secure = request.socket.encrypted || forwardedProto === "https";
  return `questboard_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function publicRecord(session = null) {
  const currentUser = session?.user || null;
  return {
    revision: record.revision,
    updatedAt: record.updatedAt,
    state: record.state,
    currentUser
  };
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

async function serveStatic(pathname, response) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(decodeURIComponent(requestedPath)).replace(/^([.][.][/\\])+/, "");
  const filePath = resolve(root, `.${safePath}`);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) throw new Error("Unsafe path");
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error("Not a file");
  const body = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": extname(filePath) === ".html" ? "no-store" : "public, max-age=300"
  });
  response.end(body);
}

function clientAddress(request) {
  return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function loginAttemptKey(request, userId) {
  return `${clientAddress(request)}:${userId}`;
}

function checkLoginRateLimit(request, userId) {
  const key = loginAttemptKey(request, userId);
  const attempt = loginAttempts.get(key);
  if (attempt?.blockedUntil > Date.now()) {
    const error = new Error("Too many incorrect attempts. Try again shortly.");
    error.statusCode = 429;
    throw error;
  }
  return key;
}

function registerFailedLogin(key) {
  const current = loginAttempts.get(key) || { failures: 0, blockedUntil: 0 };
  current.failures += 1;
  if (current.failures >= 5) {
    current.failures = 0;
    current.blockedUntil = Date.now() + 30_000;
  }
  loginAttempts.set(key, current);
}

await initialiseStore();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");

    if (url.pathname === "/api/health" && request.method === "GET") {
      sendJson(response, 200, {
        status: "ok",
        revision: record.revision,
        updatedAt: record.updatedAt
      });
      return;
    }

    if (url.pathname === "/api/auth/switch" && request.method === "POST") {
      const payload = await readJsonBody(request);
      const userId = cleanText(payload.userId, 100);
      const pin = String(payload.pin || "");
      const user = record.state.users.find((candidate) => candidate.id === userId);
      const key = checkLoginRateLimit(request, userId);
      if (!user || !PIN_PATTERN.test(pin) || !await verifyPin(pin, record.auth[userId])) {
        registerFailedLogin(key);
        sendJson(response, 401, { error: "The PIN was not correct." });
        return;
      }
      loginAttempts.delete(key);
      const existingSession = getSession(request);
      if (existingSession) sessions.delete(existingSession.token);
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, { userId, expiresAt: Date.now() + sessionMaxAgeSeconds * 1000 });
      sendJson(response, 200, publicRecord({ token, user }), {
        "Set-Cookie": cookieHeader(request, token)
      });
      return;
    }

    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      const session = getSession(request);
      if (session) sessions.delete(session.token);
      sendJson(response, 200, { ok: true }, {
        "Set-Cookie": cookieHeader(request, "", 0)
      });
      return;
    }

    if (url.pathname === "/api/state" && request.method === "GET") {
      const session = getSession(request);
      const since = Number(url.searchParams.get("since"));
      if (session && Number.isFinite(since) && since === record.revision) {
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
        return;
      }
      sendJson(response, 200, publicRecord(session));
      return;
    }

    if (url.pathname === "/api/state" && request.method === "PUT") {
      requireAdmin(request);
      const payload = await readJsonBody(request);
      const baseRevision = Number(payload.baseRevision);
      if (!Number.isFinite(baseRevision)) {
        sendJson(response, 400, { error: "baseRevision is required" });
        return;
      }
      const result = await persistAtRevision(baseRevision, payload.state || payload);
      if (result.conflict) {
        sendJson(response, 409, {
          error: "The shared data changed on another device.",
          revision: result.record.revision,
          updatedAt: result.record.updatedAt,
          state: result.record.state
        });
        return;
      }
      sendJson(response, 200, publicRecord(getSession(request)));
      return;
    }

    if (url.pathname === "/api/completions" && request.method === "POST") {
      const session = requireSession(request);
      const payload = await readJsonBody(request);
      const task = record.state.tasks.find((candidate) => candidate.id === cleanText(payload.taskId, 100));
      if (!task || task.userId !== session.user.id || task.active === false) {
        sendJson(response, 403, { error: "That quest is not available for this profile." });
        return;
      }
      const now = new Date();
      const keys = periodKeys(now, record.state.timezone);
      const currentPeriod = keys[periodProperty(task.frequency)];
      const alreadyComplete = record.state.completions.some((completion) => (
        completion.taskId === task.id &&
        completion.frequency === task.frequency &&
        completion.periodKey === currentPeriod
      ));
      if (alreadyComplete) {
        sendJson(response, 409, { error: "That quest is already complete for this period." });
        return;
      }
      const nextState = {
        ...record.state,
        completions: [...record.state.completions, createCompletion(task, now, record.state.timezone)]
      };
      await persist(nextState);
      sendJson(response, 201, publicRecord(getSession(request)));
      return;
    }

    const pinRoute = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/pin$/);
    if (pinRoute && request.method === "PUT") {
      const adminSession = requireAdmin(request);
      const userId = decodeURIComponent(pinRoute[1]);
      const user = record.state.users.find((candidate) => candidate.id === userId);
      if (!user) {
        sendJson(response, 404, { error: "Player not found." });
        return;
      }
      const payload = await readJsonBody(request);
      const pin = String(payload.pin || "");
      if (!PIN_PATTERN.test(pin)) {
        sendJson(response, 400, { error: "PINs must contain 4 to 8 digits." });
        return;
      }
      const nextAuth = { ...record.auth, [userId]: await hashPin(pin) };
      await persist(record.state, nextAuth);
      for (const [token, session] of sessions) {
        if (session.userId === userId && token !== adminSession.token) sessions.delete(token);
      }
      sendJson(response, 200, publicRecord(getSession(request)));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "API endpoint not found" });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Method not allowed");
      return;
    }

    await serveStatic(url.pathname, response);
  } catch (error) {
    if (error?.message === "Unsafe path" || error?.message === "Not a file" || error?.code === "ENOENT") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const statusCode = Number(error?.statusCode) || 400;
    if (statusCode >= 500) console.error(error);
    sendJson(response, statusCode, { error: error instanceof Error ? error.message : "Request failed" });
  }
});

server.listen(port, host, () => {
  console.log(`Questboard is running at http://${host}:${port}`);
  console.log(`Shared data is stored in ${dataFile}`);
});
