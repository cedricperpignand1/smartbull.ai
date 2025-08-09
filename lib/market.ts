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
