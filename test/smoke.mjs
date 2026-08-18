import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const port = 43173;
const baseUrl = `http://127.0.0.1:${port}`;
const dataDirectory = await mkdtemp(join(tmpdir(), "questboard-test-"));
let server;

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await delay(100);
  }
  throw new Error("Server did not become ready");
}

function startServer() {
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDirectory
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", (chunk) => process.stdout.write(chunk));
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    delay(2000)
  ]);
}

async function login(userId, pin) {
  const response = await fetch(`${baseUrl}/api/auth/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, pin })
  });
  const payload = await response.json().catch(() => ({}));
  const cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
  return { response, payload, cookie };
}

async function api(path, { method = "GET", cookie = "", body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

try {
  startServer();
  await waitForServer();

  const index = await fetch(`${baseUrl}/`).then((response) => response.text());
  if (!index.includes("Questboard family server") || !index.includes("switchDialog") || !index.includes("userAdminField") || !index.includes("reset-countdown.js") || !index.includes("progress-features.js")) {
    throw new Error("PIN-protected static app was not served");
  }
  const countdownScript = await fetch(`${baseUrl}/reset-countdown.js`).then((response) => response.text());
  if (!countdownScript.includes("formatResetCountdown")) {
    throw new Error("Reset countdown helper was not served");
  }
  const progressScript = await fetch(`${baseUrl}/progress-features.js`).then((response) => response.text());
  if (!progressScript.includes("calculateStreak")) {
    throw new Error("Streak helper was not served");
  }
  const appScript = await fetch(`${baseUrl}/app.js`).then((response) => response.text());
  if (!appScript.includes("dailyStreakStatusForUser") || !appScript.includes('streak-pill streak-${entry.streakStatus.state}') || !appScript.includes("streakFreezeActive") || !appScript.includes("streakIcon")) {
    throw new Error("Leaderboard streak progress or streak-freeze states were not served");
  }
  const styles = await fetch(`${baseUrl}/styles.css`).then((response) => response.text());
  if (!styles.includes(".switch-profile-summary > div > span") || !styles.includes("font-size: 1.9rem") || styles.includes(".switch-profile-summary span {")) {
    throw new Error("Unlock profile avatar styles could regress to the compressed avatar layout");
  }

  const initial = await api("/api/state").then((response) => response.json());
  if (initial.currentUser !== null) throw new Error("A new browser should start locked");
  if (initial.state.users.length !== 4 || initial.state.tasks.length !== 12 || initial.state.rewards.length !== 3) {
    throw new Error("Seed users, quests or rewards were not initialised correctly");
  }
  if (initial.state.streakFreezeEnabled !== false || initial.state.streakFreezePeriods.length !== 0) {
    throw new Error("Streak freeze was not disabled by default");
  }
  const admin = initial.state.users.find((user) => user.role === "admin");
  if (!admin || admin.id !== "user-parent") throw new Error("Default admin profile is missing");

  const unauthorisedSave = await api("/api/state", {
    method: "PUT",
    body: { baseRevision: initial.revision, state: initial.state }
  });
  if (unauthorisedSave.status !== 401) throw new Error("Shared settings were writable without a PIN");

  const wrongAdmin = await login("user-parent", "9999");
  if (wrongAdmin.response.status !== 401) throw new Error("Incorrect admin PIN was accepted");

  const adminLogin = await login("user-parent", "1234");
  if (!adminLogin.response.ok || !adminLogin.cookie || adminLogin.payload.currentUser?.role !== "admin") {
    throw new Error("Default admin PIN did not unlock the Parent profile");
  }
  let adminCookie = adminLogin.cookie;

  const miaLogin = await login("user-mia", "0000");
  if (!miaLogin.response.ok || miaLogin.payload.currentUser?.id !== "user-mia") {
    throw new Error("Migrated/default player PIN did not work");
  }
  const miaCookie = miaLogin.cookie;

  const childSettingsWrite = await api("/api/state", {
    method: "PUT",
    cookie: miaCookie,
    body: { baseRevision: miaLogin.payload.revision, state: miaLogin.payload.state }
  });
  if (childSettingsWrite.status !== 403) throw new Error("A child profile could change admin settings");

  const miaTask = initial.state.tasks.find((task) => task.id === "task-mia-room");
  const leoTask = initial.state.tasks.find((task) => task.userId === "user-leo");
  const completionResponse = await api("/api/completions", {
    method: "POST",
    cookie: miaCookie,
    body: { taskId: miaTask.id }
  });
  if (completionResponse.status !== 201) {
    throw new Error(`Own task completion failed: ${await completionResponse.text()}`);
  }

  const otherCompletion = await api("/api/completions", {
    method: "POST",
    cookie: miaCookie,
    body: { taskId: leoTask.id }
  });
  if (otherCompletion.status !== 403) throw new Error("A child completed another user's quest");

  const pinUpdate = await api("/api/admin/users/user-mia/pin", {
    method: "PUT",
    cookie: adminCookie,
    body: { pin: "2468" }
  });
  if (!pinUpdate.ok) throw new Error(`Admin PIN update failed: ${await pinUpdate.text()}`);

  const staleChildSession = await api("/api/completions", {
    method: "POST",
    cookie: miaCookie,
    body: { taskId: miaTask.id }
  });
  if (staleChildSession.status !== 401) throw new Error("Changing a player PIN did not lock their existing sessions");

  const oldMiaPin = await login("user-mia", "0000");
  if (oldMiaPin.response.status !== 401) throw new Error("Old player PIN remained valid");
  const newMiaPin = await login("user-mia", "2468");
  if (!newMiaPin.response.ok) throw new Error("New player PIN did not work");

  const beforeAdd = await api("/api/state", { cookie: adminCookie }).then((response) => response.json());
  const withNewPlayer = structuredClone(beforeAdd.state);
  withNewPlayer.users.push({
    id: "user-test-child",
    name: "Test Child",
    avatar: "⭐",
    colour: "#6d5dfc",
    role: "player",
    createdAt: new Date().toISOString()
  });
  withNewPlayer.rewards.push({
    id: "reward-test",
    title: "Test Reward",
    description: "Created by the admin smoke test",
    icon: "🎁",
    threshold: 375,
    active: true,
    createdAt: new Date().toISOString()
  });
  const addPlayer = await api("/api/state", {
    method: "PUT",
    cookie: adminCookie,
    body: { baseRevision: beforeAdd.revision, state: withNewPlayer }
  });
  if (!addPlayer.ok) throw new Error(`Admin could not add a protected player: ${await addPlayer.text()}`);
  const newPin = await api("/api/admin/users/user-test-child/pin", {
    method: "PUT",
    cookie: adminCookie,
    body: { pin: "1357" }
  });
  if (!newPin.ok || !(await login("user-test-child", "1357")).response.ok) {
    throw new Error("A newly created player's PIN did not work");
  }

  const beforePromotion = await api("/api/state", { cookie: adminCookie }).then((response) => response.json());
  const promotedState = structuredClone(beforePromotion.state);
  promotedState.streakResetMonthly = true;
  promotedState.streakFreezeEnabled = true;
  promotedState.users.find((user) => user.id === "user-mia").role = "admin";
  const promoteMia = await api("/api/state", {
    method: "PUT",
    cookie: adminCookie,
    body: { baseRevision: beforePromotion.revision, state: promotedState }
  });
  if (!promoteMia.ok) throw new Error(`Admin could not promote another account: ${await promoteMia.text()}`);
  const promotedMiaLogin = await login("user-mia", "2468");
  if (!promotedMiaLogin.response.ok || promotedMiaLogin.payload.currentUser?.role !== "admin") {
    throw new Error("A promoted account did not receive admin permissions");
  }
  const promotedAdminSave = await api("/api/state", {
    method: "PUT",
    cookie: promotedMiaLogin.cookie,
    body: { baseRevision: promotedMiaLogin.payload.revision, state: promotedMiaLogin.payload.state }
  });
  if (!promotedAdminSave.ok) throw new Error("A second administrator could not save shared settings");

  const current = await api("/api/state", { cookie: adminCookie }).then((response) => response.json());
  if (current.state.users.filter((user) => user.role === "admin").length !== 2 || current.state.streakResetMonthly !== true) {
    throw new Error("Multiple administrators or monthly streak settings were not persisted");
  }
  if (current.state.streakFreezeEnabled !== true || !current.state.streakFreezePeriods.some((period) => !period.endDay)) {
    throw new Error("Streak freeze setting or active freeze period was not persisted");
  }
  const stateA = structuredClone(current.state);
  const stateB = structuredClone(current.state);
  stateA.tasks[0].title = "Concurrent change A";
  stateB.tasks[0].title = "Concurrent change B";

  const save = (state) => api("/api/state", {
    method: "PUT",
    cookie: adminCookie,
    body: { baseRevision: current.revision, state }
  });
  const responses = await Promise.all([save(stateA), save(stateB)]);
  const statuses = responses.map((response) => response.status).sort();
  if (statuses[0] !== 200 || statuses[1] !== 409) {
    throw new Error(`Expected atomic conflict detection, got ${statuses.join(", ")}`);
  }

  await stopServer();
  startServer();
  await waitForServer();

  const lockedAfterRestart = await api("/api/state").then((response) => response.json());
  if (lockedAfterRestart.currentUser !== null) throw new Error("Sessions unexpectedly persisted across restart");

  const restoredAdmin = await login("user-parent", "1234");
  if (!restoredAdmin.response.ok) throw new Error("Admin PIN did not persist across restart");
  adminCookie = restoredAdmin.cookie;
  const restoredMia = await login("user-mia", "2468");
  if (!restoredMia.response.ok) throw new Error("Edited player PIN did not persist across restart");

  const restored = await api("/api/state", { cookie: adminCookie }).then((response) => response.json());
  if (!restored.state.completions.some((item) => item.taskId === miaTask.id && item.userId === "user-mia")) {
    throw new Error("Completion data did not persist across a server restart");
  }
  if (!restored.state.rewards.some((reward) => reward.id === "reward-test" && reward.threshold === 375)) {
    throw new Error("Admin-created reward data did not persist across a server restart");
  }
  if (restored.state.streakFreezeEnabled !== true || !restored.state.streakFreezePeriods.some((period) => !period.endDay)) {
    throw new Error("Streak freeze did not persist across a server restart");
  }

  const storedText = await readFile(join(dataDirectory, "questboard.json"), "utf8");
  const storedRecord = JSON.parse(storedText);
  if (storedRecord.revision !== restored.revision) throw new Error("Stored revision is inconsistent");
  if (storedText.includes('"1234"') || storedText.includes('"2468"')) {
    throw new Error("A PIN was stored as plaintext");
  }
  if (!storedRecord.auth?.["user-parent"]?.hash || !storedRecord.auth?.["user-mia"]?.hash) {
    throw new Error("PIN hashes were not persisted");
  }

  console.log("Questboard PIN and persistence smoke tests passed.");
} finally {
  await stopServer();
  await rm(dataDirectory, { recursive: true, force: true });
}
