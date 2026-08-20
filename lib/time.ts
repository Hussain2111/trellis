/**
 * Riyadh-local time. Every `timestamptz` column in this database stays UTC —
 * this module is a comparison and presentation layer only, never a storage
 * format.
 *
 * Saudi Arabia is UTC+3 all year and has observed no DST since 1990, so the
 * arithmetic below uses a fixed offset rather than pulling in a timezone
 * library for a single zone. Formatting goes through `Intl` with an explicit
 * `timeZone`, which is already correct and needs no offset of its own.
 */

export const RIYADH_TZ = 'Asia/Riyadh';
const OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * "Now" as a Date whose **UTC getters** read as Riyadh wall-clock time —
 * `nowRiyadh().getUTCHours()` is the hour a clock in Riyadh shows. Its
 * `getTime()` is deliberately not a real instant; use it for calendar
 * arithmetic, never for storing or comparing against a stored timestamp.
 */
export function nowRiyadh(now: Date = new Date()): Date {
  return new Date(now.getTime() + OFFSET_MS);
}

/** The Riyadh calendar day an instant falls on, as `YYYY-MM-DD`. */
export function riyadhDay(instant: Date): string {
  return new Date(instant.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The real UTC instant of Monday 00:00 Riyadh in the week containing `instant`.
 * Weeks start Monday — the reporting convention the weekly rollup uses.
 */
export function startOfWeekRiyadh(instant: Date = new Date()): Date {
  const local = new Date(instant.getTime() + OFFSET_MS);
  const dow = local.getUTCDay(); // 0 = Sunday
  const daysSinceMonday = (dow + 6) % 7;
  local.setUTCDate(local.getUTCDate() - daysSinceMonday);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - OFFSET_MS);
}

/** The real UTC instant of 00:00 Riyadh on the day containing `instant`. */
export function startOfDayRiyadh(instant: Date = new Date()): Date {
  const local = new Date(instant.getTime() + OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - OFFSET_MS);
}

/** Its moment has arrived or passed. Says nothing about whether it happened. */
export function isDue(scheduledFor: Date, now: Date = new Date()): boolean {
  return scheduledFor.getTime() <= now.getTime();
}

/**
 * Due, and the Riyadh day it was meant for has already rolled over — the
 * distinction that makes "due" mean "do it now" rather than "you missed it".
 * Something scheduled for 09:00 that is now 14:00 the same day is due, not
 * overdue.
 */
export function isOverdue(scheduledFor: Date, now: Date = new Date()): boolean {
  return riyadhDay(scheduledFor) < riyadhDay(now);
}

const DEFAULT_FORMAT: Intl.DateTimeFormatOptions = {
  dateStyle: 'medium',
  timeStyle: 'short',
};

/** Human-readable Riyadh-local rendering. Safe to call on the server. */
export function formatRiyadh(
  instant: Date,
  options: Intl.DateTimeFormatOptions = DEFAULT_FORMAT,
): string {
  return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: RIYADH_TZ }).format(instant);
}
