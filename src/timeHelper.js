// src/timeHelper.js
// WIB timezone helpers + strict hours logic

export function getWIBHour() {
  return (new Date().getUTCHours() + 7) % 24;
}

export function isStrictHours() {
  const h = getWIBHour();
  return h >= 14 && h < 18;
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
