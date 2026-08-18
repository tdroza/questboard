import "../progress-features.js";

const { calculateStreak, dailyStreakStatus } = globalThis.QuestboardProgressFeatures;
const userId = "user-child";

function task(id, createdAt = "2026-07-01T00:00:00.000Z", active = true) {
  return { id, userId, frequency: "daily", active, createdAt };
}

function completion(taskId, dayKey) {
  return { id: `${taskId}-${dayKey}`, taskId, userId, frequency: "daily", dayKey, completedAt: `${dayKey}T12:00:00.000Z` };
}

const now = new Date("2026-07-22T12:00:00.000Z");
const baseTasks = [task("bed"), task("teeth")];
const threeCompleteDays = ["2026-07-20", "2026-07-21", "2026-07-22"].flatMap((day) => [completion("bed", day), completion("teeth", day)]);

if (calculateStreak({ userId, tasks: baseTasks, completions: threeCompleteDays, timezone: "UTC", now }) !== 3) {
  throw new Error("A completed current day did not extend the streak");
}

const todayIncomplete = threeCompleteDays.filter((item) => !(item.dayKey === "2026-07-22" && item.taskId === "teeth"));
if (calculateStreak({ userId, tasks: baseTasks, completions: todayIncomplete, timezone: "UTC", now }) !== 2) {
  throw new Error("An unfinished current day incorrectly erased yesterday's streak");
}

const missedYesterday = threeCompleteDays.filter((item) => item.dayKey !== "2026-07-21");
if (calculateStreak({ userId, tasks: baseTasks, completions: missedYesterday, timezone: "UTC", now }) !== 1) {
  throw new Error("A missed historic day did not break the streak");
}

const newTodayTask = [...baseTasks, task("lunchbox", "2026-07-22T08:00:00.000Z")];
if (calculateStreak({ userId, tasks: newTodayTask, completions: todayIncomplete, timezone: "UTC", now }) !== 2) {
  throw new Error("A newly created task retroactively broke earlier days");
}

const withInactiveTask = [...baseTasks, task("paused", "2026-07-01T00:00:00.000Z", false)];
if (calculateStreak({ userId, tasks: withInactiveTask, completions: threeCompleteDays, timezone: "UTC", now }) !== 3) {
  throw new Error("A paused daily task was included in streak requirements");
}

if (calculateStreak({ userId, tasks: [], completions: [], timezone: "UTC", now }) !== 0) {
  throw new Error("A player with no daily quests should have a zero streak");
}

console.log("Questboard streak calculation tests passed.");

const monthBoundaryNow = new Date("2026-08-02T12:00:00.000Z");
const acrossMonthCompletions = ["2026-07-31", "2026-08-01", "2026-08-02"].flatMap((day) => [completion("bed", day), completion("teeth", day)]);
if (calculateStreak({ userId, tasks: baseTasks, completions: acrossMonthCompletions, timezone: "UTC", now: monthBoundaryNow }) !== 3) {
  throw new Error("A perpetual streak did not continue across a month boundary");
}
if (calculateStreak({ userId, tasks: baseTasks, completions: acrossMonthCompletions, timezone: "UTC", now: monthBoundaryNow, resetMonthly: true }) !== 2) {
  throw new Error("A monthly-reset streak included days from the previous month");
}
const greyStatus = dailyStreakStatus({ completed: 0, total: 5 });
if (greyStatus.state !== "grey" || greyStatus.remaining !== 5 || greyStatus.message !== "5 quests remaining") {
  throw new Error("Zero completed daily quests did not produce the grey streak state");
}

const yellowStatus = dailyStreakStatus({ completed: 2, total: 5 });
if (yellowStatus.state !== "yellow" || yellowStatus.remaining !== 3 || yellowStatus.message !== "3 quests remaining") {
  throw new Error("Partial daily quest progress did not produce the yellow streak state");
}

const brightStatus = dailyStreakStatus({ completed: 5, total: 5 });
if (brightStatus.state !== "bright" || brightStatus.remaining !== 0 || brightStatus.message !== "Streak secured ✓") {
  throw new Error("Completed daily quests did not produce the bright streak state");
}

const noQuestsStatus = dailyStreakStatus({ completed: 0, total: 0 });
if (noQuestsStatus.state !== "bright" || noQuestsStatus.message !== "No daily quests today") {
  throw new Error("A day with no active daily quests should show the bright no-quests state");
}


const frozenStatus = dailyStreakStatus({ completed: 2, total: 5, frozen: true });
if (frozenStatus.state !== "frozen" || frozenStatus.message !== "Streak freeze active") {
  throw new Error("An active streak freeze did not produce the frozen status state");
}

const freezeMissCompletions = ["2026-07-20", "2026-07-22"].flatMap((day) => [completion("bed", day), completion("teeth", day)]);
const oneFrozenDay = [{ id: "freeze-1", startDay: "2026-07-21", endDay: "2026-07-21" }];
if (calculateStreak({ userId, tasks: baseTasks, completions: freezeMissCompletions, timezone: "UTC", now, freezePeriods: oneFrozenDay }) !== 2) {
  throw new Error("A protected missed day broke or incremented the streak");
}

const activeFreeze = [{ id: "freeze-2", startDay: "2026-07-22", endDay: null }];
const yesterdayOnly = ["2026-07-21"].flatMap((day) => [completion("bed", day), completion("teeth", day)]);
if (calculateStreak({ userId, tasks: baseTasks, completions: yesterdayOnly, timezone: "UTC", now, freezePeriods: activeFreeze }) !== 1) {
  throw new Error("An active streak freeze did not preserve the streak through an incomplete current day");
}

if (calculateStreak({ userId, tasks: baseTasks, completions: threeCompleteDays, timezone: "UTC", now, freezePeriods: activeFreeze }) !== 2) {
  throw new Error("A frozen completed day incorrectly increased the streak");
}

console.log("Questboard streak freeze tests passed.");
