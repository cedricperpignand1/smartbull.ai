// lib/market.ts

export function nowET(): Date {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
}

export function isWeekdayET() {
  const d = nowET().getDay();
  return d >= 1 && d <= 5; // Mon–Fri
}

export function isMarketHoursET() {
  const d = nowET();
  const h = d.getHours();
  const m = d.getMinutes();
  return (h > 9 || (h === 9 && m >= 30)) && h < 16;
}

export function is940ET() {
  const d = nowET();
  return d.getHours() === 9 && d.getMinutes() === 40;
}

export function yyyyMmDdET() {
  const d = nowET();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}`;
}

/** Generic ET window checker */
export function isBetweenET(startH: number, startM: number, endH: number, endM: number) {
  const d = nowET();
  const nowMins = d.getHours() * 60 + d.getMinutes();
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;
  return nowMins >= start && nowMins <= end;
}

/** 9:30–10:30 ET morning entry window */
export function isMorningWindowET() {
  return isBetweenET(9, 30, 3, 30);
}

/** Is it at or after a given ET time? */
export function isAtOrAfterET(h: number, m: number) {
  const d = nowET();
  const nowMins = d.getHours() * 60 + d.getMinutes();
  const tgtMins = h * 60 + m;
  return nowMins >= tgtMins;
}

/** Time stop at 3:45 PM ET (15:45) */
export function isTimeStopET() {
  return isAtOrAfterET(15, 45);
}
