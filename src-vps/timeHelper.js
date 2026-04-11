// src-vps/timeHelper.js
// WIB timezone helpers + strict hours logic

export function getWIBHour() {
  return (new Date().getUTCHours() + 7) % 24;
}

export function isStrictHours() {
  const h = getWIBHour();
  const start = Number(process.env.ACTIVE_HOURS_START ?? 14);
  const end = Number(process.env.ACTIVE_HOURS_END ?? 18);
  return h >= start && h < end;
}

export function formatWIB(date = new Date()) {
  const wib = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const h = wib.getUTCHours().toString().padStart(2, "0");
  const m = wib.getUTCMinutes().toString().padStart(2, "0");
  return h + ":" + m + " WIB";
}

export function toWIB(date = new Date()) {
  return new Date(date.getTime() + 7 * 60 * 60 * 1000);
}
