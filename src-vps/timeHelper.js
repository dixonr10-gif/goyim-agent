// src-vps/timeHelper.js
// WIB timezone helpers + strict hours logic

export function getWIBHour() {
  return (new Date().getUTCHours() + 7) % 24;
}

export function getWIBMinute() {
  return new Date().getUTCMinutes();
}

export function isStrictHours() {
  // Minute-granular window so the env can express e.g. 13:30–20:30 WIB.
  // ACTIVE_HOURS_START_MIN / ACTIVE_HOURS_END_MIN default to 30.
  const nowMin = getWIBHour() * 60 + getWIBMinute();
  const startMin = Number(process.env.ACTIVE_HOURS_START ?? 13) * 60
    + Number(process.env.ACTIVE_HOURS_START_MIN ?? 30);
  const endMin = Number(process.env.ACTIVE_HOURS_END ?? 20) * 60
    + Number(process.env.ACTIVE_HOURS_END_MIN ?? 30);
  return nowMin >= startMin && nowMin < endMin;
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
