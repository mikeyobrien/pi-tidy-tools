/**
 * Minimal 5-field cron matcher (minute hour day-of-month month day-of-week).
 * Supports: number, * , ranges (a-b), lists (a,b), steps (a-b/s, * /s).
 * Pure and hermetic: isDue(date, expr) has no clocks inside.
 */

interface Fields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

function parseField(raw: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1)
      throw new Error(`bad step in "${part}"`);
    let start = min;
    let end = max;
    if (rangePart !== "*" && rangePart !== "") {
      const dash = rangePart.indexOf("-");
      if (dash === -1) {
        start = Number(rangePart);
        end = start;
      } else {
        start = Number(rangePart.slice(0, dash));
        end = Number(rangePart.slice(dash + 1));
      }
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      throw new Error(`range "${rangePart}" out of bounds ${min}-${max}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expr: string): Fields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new Error(`cron expr must have 5 fields: "${expr}"`);
  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    daysOfMonth: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    daysOfWeek: parseField(parts[4], 0, 7),
  };
}

/** True when the date matches the cron expression (minute resolution). */
export function isDue(date: Date, expr: string): boolean {
  const fields = parseCron(expr);
  if (!fields.minutes.has(date.getMinutes())) return false;
  if (!fields.hours.has(date.getHours())) return false;
  if (!fields.months.has(date.getMonth() + 1)) return false;
  if (!fields.daysOfMonth.has(date.getDate())) return false;
  // POSIX crontab semantics: if both day fields are restricted, either may match.
  const domRestricted = expr.trim().split(/\s+/)[2] !== "*";
  const dowRestricted = expr.trim().split(/\s+/)[4] !== "*";
  const dayMatches =
    (!domRestricted || fields.daysOfMonth.has(date.getDate())) &&
    (!dowRestricted ||
      fields.daysOfWeek.has(date.getDay() === 0 ? 7 : date.getDay()));
  if (domRestricted && dowRestricted) {
    return (
      fields.minutes.has(date.getMinutes()) &&
      fields.hours.has(date.getHours()) &&
      fields.months.has(date.getMonth() + 1) &&
      (fields.daysOfMonth.has(date.getDate()) ||
        fields.daysOfWeek.has(date.getDay() === 0 ? 7 : date.getDay()))
    );
  }
  return dayMatches;
}

export function minuteKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
