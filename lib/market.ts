// lib/market.ts

/** Current ET (handles DST) */
export function nowET(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

/** YYYY-MM-DD in ET */
export function yyyyMmDdET(): string {
  const d = nowET();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}`;
}

/** Mon–Fri (no holiday awareness) */
export function isWeekdayET(): boolean {
  const dow = nowET().getDay();
  return dow >= 1 && dow <= 5;
}

/** Regular market hours 09:30–16:00 ET (true until 15:59:59) */
export function isMarketHoursET(): boolean {
  const d = nowET();
  const h = d.getHours();
  const m = d.getMinutes();
  return (h > 9 || (h === 9 && m >= 30)) && h < 16;
}

/** Generic ET window checker (inclusive minutes) */
export function isBetweenET(startH: number, startM: number, endH: number, endM: number): boolean {
  const d = nowET();
  const nowMins = d.getHours() * 60 + d.getMinutes();
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;
  return nowMins >= start && nowMins <= end;
}

/** Minutes since 09:30 ET (clamped at 0 if before open) */
export function minutesSinceOpenET(): number {
  const d = nowET();
  const mins = d.getHours() * 60 + d.getMinutes();
  return Math.max(0, mins - (9 * 60 + 30));
}

/** Named windows your bot uses */
export function inPreScanWindowET(): boolean {
  // 09:14:00–09:29:59
  return isBetweenET(9, 14, 9, 29);
}
export function inScanWindowET(): boolean {
  // 09:30:00–10:14:59
  return isBetweenET(9, 30, 10, 14);
}
export function inForceWindowET(): boolean {
  // 10:15:00–10:16:59
  const d = nowET();
  return d.getHours() === 10 && (d.getMinutes() === 15 || d.getMinutes() === 16);
}
export function inEndOfForceFailsafeET(): boolean {
  // 10:16:30–10:16:59 (used to clear a stuck lock)
  const d = nowET();
  return d.getHours() === 10 && d.getMinutes() === 16 && d.getSeconds() >= 30;
}
export function isMandatoryExitET(): boolean {
  // 15:55+
  const d = nowET();
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= (15 * 60 + 55);
}

/** At/after a given ET time (minutes precision) */
export function isAtOrAfterET(h: number, m: number): boolean {
  const d = nowET();
  const nowMins = d.getHours() * 60 + d.getMinutes();
  return nowMins >= (h * 60 + m);
}

/** Time stop at 15:45 ET (if you ever need it) */
export function isTimeStopET(): boolean {
  return isAtOrAfterET(15, 45);
}

/** (Optional) Corrected name for your old helper:
 * Previously named isMorningWindowET, but it actually covered 09:30–15:30.
 */
export function isDayBlockET(): boolean {
  return isBetweenET(9, 30, 15, 30);
}
