import "../reset-countdown.js";

const { formatResetCountdown, nextResetInstant } = globalThis.QuestboardResetCountdown;

function expectEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, received ${actual}`);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

expectEqual(
  formatResetCountdown("daily", new Date("2026-07-22T12:10:00Z"), "Europe/London"),
  "Resets in 11 hours",
  "Daily countdown should round to the nearest half hour"
);

expectEqual(
  formatResetCountdown("daily", new Date("2026-07-22T22:38:00Z"), "Europe/London"),
  "Resets in 30 minutes",
  "Daily countdown should not display zero near midnight"
);

expectEqual(
  formatResetCountdown("weekly", new Date("2026-07-22T12:00:00Z"), "Europe/London"),
  "Resets in 4 days",
  "Weekly countdown should show whole days outside the final 48 hours"
);

expectEqual(
  formatResetCountdown("weekly", new Date("2026-07-25T18:00:00Z"), "Europe/London"),
  "Resets in 1 day 5 hours",
  "Weekly countdown should show days and hours inside the final 48 hours"
);

expectEqual(
  formatResetCountdown("monthly", new Date("2026-07-30T10:00:00Z"), "Europe/London"),
  "Resets in 1 day 13 hours",
  "Monthly countdown should show days and hours inside the final 48 hours"
);

expectEqual(
  nextResetInstant("daily", new Date("2026-03-28T20:00:00Z"), "Europe/London").toISOString(),
  "2026-03-29T00:00:00.000Z",
  "Daily reset should use local midnight before the spring DST transition"
);

expectEqual(
  nextResetInstant("daily", new Date("2026-03-29T12:00:00Z"), "Europe/London").toISOString(),
  "2026-03-29T23:00:00.000Z",
  "Daily reset should use local midnight after the spring DST transition"
);

expect(
  formatResetCountdown("monthly", new Date("2026-12-20T12:00:00Z"), "Pacific/Auckland").startsWith("Resets in "),
  "Countdown should support other valid IANA timezones"
);

console.log("Countdown tests passed");
