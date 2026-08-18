(function attachQuestboardProgressFeatures(globalObject) {
  "use strict";

  const DAY_MS = 86_400_000;

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function civilDayKey(date, timezone = "Europe/London") {
    const value = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(value.getTime())) return null;
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(value)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)])
    );
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  }

  function shiftDayKey(dayKey, dayOffset) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ""));
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + dayOffset * DAY_MS);
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  }

  function dailyStreakStatus({ completed = 0, total = 0, frozen = false } = {}) {
    const safeTotal = Math.max(0, Number.isFinite(Number(total)) ? Math.trunc(Number(total)) : 0);
    const safeCompleted = Math.max(0, Math.min(safeTotal, Number.isFinite(Number(completed)) ? Math.trunc(Number(completed)) : 0));
    const remaining = Math.max(0, safeTotal - safeCompleted);

    if (frozen) {
      return { state: "frozen", completed: safeCompleted, total: safeTotal, remaining, message: "Streak freeze active" };
    }
    if (safeTotal === 0) {
      return { state: "bright", completed: 0, total: 0, remaining: 0, message: "No daily quests today" };
    }
    if (safeCompleted === 0) {
      return { state: "grey", completed: 0, total: safeTotal, remaining, message: `${remaining} quest${remaining === 1 ? "" : "s"} remaining` };
    }
    if (safeCompleted >= safeTotal) {
      return { state: "bright", completed: safeTotal, total: safeTotal, remaining: 0, message: "Streak secured ✓" };
    }
    return { state: "yellow", completed: safeCompleted, total: safeTotal, remaining, message: `${remaining} quest${remaining === 1 ? "" : "s"} remaining` };
  }

  function isFrozenDay(dayKey, freezePeriods = []) {
    return freezePeriods.some((period) => {
      const startDay = /^\d{4}-\d{2}-\d{2}$/.test(String(period?.startDay || "")) ? period.startDay : null;
      const endDay = /^\d{4}-\d{2}-\d{2}$/.test(String(period?.endDay || "")) ? period.endDay : null;
      if (!startDay || dayKey < startDay) return false;
      return !endDay || dayKey <= endDay;
    });
  }

  function calculateStreak({ userId, tasks = [], completions = [], timezone = "Europe/London", now = new Date(), resetMonthly = false, freezePeriods = [] }) {
    const dailyTasks = tasks.filter((task) => (
      task?.userId === userId &&
      task?.frequency === "daily" &&
      task?.active !== false
    ));
    if (!dailyTasks.length) return 0;

    const taskStartDays = new Map(dailyTasks.map((task) => [
      task.id,
      civilDayKey(task.createdAt || now, timezone) || "0000-00-00"
    ]));
    const completionDaysByTask = new Map(dailyTasks.map((task) => [task.id, new Set()]));

    completions.forEach((completion) => {
      if (completion?.userId !== userId || completion?.frequency !== "daily") return;
      const completionDays = completionDaysByTask.get(completion.taskId);
      if (!completionDays) return;
      const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(String(completion.dayKey || ""))
        ? completion.dayKey
        : civilDayKey(completion.completedAt, timezone);
      if (dayKey) completionDays.add(dayKey);
    });

    function isCompleteDay(dayKey) {
      const requiredTasks = dailyTasks.filter((task) => taskStartDays.get(task.id) <= dayKey);
      if (!requiredTasks.length) return false;
      return requiredTasks.every((task) => completionDaysByTask.get(task.id)?.has(dayKey));
    }

    const todayKey = civilDayKey(now, timezone);
    if (!todayKey) return 0;
    let cursor = isFrozenDay(todayKey, freezePeriods) || isCompleteDay(todayKey) ? todayKey : shiftDayKey(todayKey, -1);
    const monthStartKey = resetMonthly ? `${todayKey.slice(0, 7)}-01` : null;
    let streak = 0;
    let scannedDays = 0;

    while (cursor && (!monthStartKey || cursor >= monthStartKey) && scannedDays < 36_600) {
      scannedDays += 1;
      if (isFrozenDay(cursor, freezePeriods)) {
        cursor = shiftDayKey(cursor, -1);
        continue;
      }
      if (!isCompleteDay(cursor)) break;
      streak += 1;
      cursor = shiftDayKey(cursor, -1);
    }

    return streak;
  }

  globalObject.QuestboardProgressFeatures = Object.freeze({
    calculateStreak,
    dailyStreakStatus,
    civilDayKey,
    shiftDayKey,
    isFrozenDay
  });
})(globalThis);
