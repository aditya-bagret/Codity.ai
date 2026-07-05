import cronParser from "cron-parser";

const { parseExpression } = cronParser;

/** Next occurrence of a cron expression strictly after `from`. */
export function nextCronRun(expression: string, timezone = "UTC", from: Date = new Date()): Date {
  const interval = parseExpression(expression, { currentDate: from, tz: timezone });
  return interval.next().toDate();
}

/** Returns an error message for an invalid expression/timezone, or null if valid. */
export function cronValidationError(expression: string, timezone = "UTC"): string | null {
  try {
    // Computing an occurrence forces timezone resolution; a bad tz only
    // surfaces when a date is actually materialized.
    parseExpression(expression, { tz: timezone }).next();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
