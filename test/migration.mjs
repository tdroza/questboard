import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const port = 43174;
const baseUrl = `http://127.0.0.1:${port}`;
const dataDirectory = await mkdtemp(join(tmpdir(), "questboard-migration-test-"));
let server;

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {
      // Still starting.
    }
    await delay(100);
  }
  throw new Error("Migration test server did not become ready");
}

async function login(userId, pin) {
  return fetch(`${baseUrl}/api/auth/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, pin })
  });
}

try {
  const createdAt = "2026-01-01T00:00:00.000Z";
  const oldRecord = {
    revision: 7,
    updatedAt: createdAt,
    state: {
      version: 1,
      timezone: "Europe/London",
      users: [
        { id: "user-mia", name: "Mia", avatar: "🦊", colour: "#6d5dfc", createdAt },
        { id: "user-leo", name: "Leo", avatar: "🐯", colour: "#f28b42", createdAt }
      ],
      tasks: [
        { id: "task-mia-bed", userId: "user-mia", title: "Make the bed", description: "", frequency: "daily", xp: 10, active: true, createdAt }
      ],
      completions: []
    }
  };
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(join(dataDirectory, "questboard.json"), JSON.stringify(oldRecord), "utf8");

  server = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDirectory },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", (chunk) => process.stdout.write(chunk));
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForServer();

  const migrated = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
  const admin = migrated.state.users.find((user) => user.role === "admin");
  if (!admin || admin.id !== "user-parent") throw new Error("Legacy data did not gain a Parent admin profile");
  if (!migrated.state.users.some((user) => user.id === "user-mia") || !migrated.state.tasks.some((task) => task.id === "task-mia-bed")) {
    throw new Error("Legacy users or tasks were lost during migration");
  }
  if (migrated.state.version !== 4 || !Array.isArray(migrated.state.rewards)) {
    throw new Error("Legacy data did not migrate to the current schema");
  }
  if (migrated.state.streakResetMonthly !== false) throw new Error("Legacy data did not receive the perpetual-streak default");
  if (!(await login("user-parent", "1234")).ok) throw new Error("Migrated admin default PIN did not work");
  if (!(await login("user-mia", "0000")).ok) throw new Error("Migrated child default PIN did not work");

  const stored = JSON.parse(await readFile(join(dataDirectory, "questboard.json"), "utf8"));
  if (!stored.auth?.["user-parent"]?.hash || !stored.auth?.["user-mia"]?.hash) {
    throw new Error("Migration did not persist PIN hashes");
  }
  console.log("Questboard legacy-data migration test passed.");
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(2000)]);
  }
  await rm(dataDirectory, { recursive: true, force: true });
}
