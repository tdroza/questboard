(function attachQuestboardResetCountdown(globalObject) {
  "use strict";

  const HOUR_MS = 60 * 60 * 1000;
  const HALF_HOUR_MS = 30 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  function civilDateTimeParts(date, timezone) {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      second: Number(parts.second)
    };
  }

  function addCivilDays(civilDate, numberOfDays) {
    const value = new Date(Date.UTC(civilDate.year, civilDate.month - 1, civilDate.day + numberOfDays));
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate()
    };
  }

  function zonedCivilTimeToInstant(civilTime, timezone) {
    const targetAsUtc = Date.UTC(
      civilTime.year,
      civilTime.month - 1,
      civilTime.day,
      civilTime.hour || 0,
      civilTime.minute || 0,
      civilTime.second || 0
    );
    let candidate = targetAsUtc;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const observed = civilDateTimeParts(new Date(candidate), timezone);
      const observedAsUtc = Date.UTC(
        observed.year,
        observed.month - 1,
        observed.day,
        observed.hour,
        observed.minute,
        observed.second
      );
      const adjustment = targetAsUtc - observedAsUtc;
      candidate += adjustment;
      if (adjustment === 0) break;
    }

    return new Date(candidate);
  }

  function nextResetInstant(frequency, now = new Date(), timezone = "Europe/London") {
    const current = civilDateTimeParts(now, timezone);
    let resetDate;

    if (frequency === "daily") {
      resetDate = addCivilDays(current, 1);
    } else if (frequency === "weekly") {
      const weekday = new Date(Date.UTC(current.year, current.month - 1, current.day)).getUTCDay();
      const daysUntilMonday = ((8 - weekday) % 7) || 7;
      resetDate = addCivilDays(current, daysUntilMonday);
    } else if (frequency === "monthly") {
      resetDate = current.month === 12
        ? { year: current.year + 1, month: 1, day: 1 }
        : { year: current.year, month: current.month + 1, day: 1 };
    } else {
      throw new RangeError(`Unsupported frequency: ${frequency}`);
    }

    return zonedCivilTimeToInstant({ ...resetDate, hour: 0, minute: 0, second: 0 }, timezone);
  }

  function plural(value, word) {
    return `${value} ${word}${value === 1 ? "" : "s"}`;
  }

  function dailyCountdown(milliseconds) {
    const halfHours = Math.max(1, Math.round(milliseconds / HALF_HOUR_MS));
    const hours = Math.floor(halfHours / 2);
    const hasHalfHour = halfHours % 2 === 1;
    if (hours === 0) return "30 minutes";
    if (!hasHalfHour) return plural(hours, "hour");
    return `${plural(hours, "hour")} 30 minutes`;
  }

  function longerCountdown(milliseconds) {
    if (milliseconds >= 2 * DAY_MS) {
      const days = Math.max(2, Math.round(milliseconds / DAY_MS));
      return plural(days, "day");
    }

    const roundedHours = Math.min(47, Math.max(1, Math.round(milliseconds / HOUR_MS)));
    const days = Math.floor(roundedHours / 24);
    const hours = roundedHours % 24;
    if (days > 0 && hours > 0) return `${plural(days, "day")} ${plural(hours, "hour")}`;
    if (days > 0) return plural(days, "day");
    return plural(hours, "hour");
  }

  function formatResetCountdown(frequency, now = new Date(), timezone = "Europe/London") {
    const resetAt = nextResetInstant(frequency, now, timezone);
    const milliseconds = Math.max(1, resetAt.getTime() - now.getTime());
    const remaining = frequency === "daily"
      ? dailyCountdown(milliseconds)
      : longerCountdown(milliseconds);
    return `Resets in ${remaining}`;
  }

  globalObject.QuestboardResetCountdown = Object.freeze({
    formatResetCountdown,
    nextResetInstant
  });
})(globalThis);
