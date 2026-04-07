// src/dailyLessons.js — Store daily review insights for human reference (read-only, not injected to LLM)

import fs from "fs";
import path from "path";

const LESSONS_FILE = path.resolve("data/daily_lessons.json");
const MAX_ENTRIES = 30;

function load() {
  try { return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf-8")); } catch { return { lessons: [] }; }
}

function save(data) {
  try {
    fs.mkdirSync(path.dirname(LESSONS_FILE), { recursive: true });
    fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

export function saveDailyLesson({ winRate, totalPnlSol, topWin, worstLoss, tradesCount, lesson, planBesok }) {
  const data = load();
  const today = new Date().toISOString().slice(0, 10);

  // Replace if same date already exists
  data.lessons = data.lessons.filter(l => l.date !== today);

  data.lessons.push({
    date: today,
    winRate: winRate ?? null,
    totalPnlSol: totalPnlSol ?? null,
    topWin: topWin ?? null,
    worstLoss: worstLoss ?? null,
    tradesCount: tradesCount ?? 0,
    lesson: lesson ?? null,
    planBesok: planBesok ?? null,
  });

  // Keep rolling window
  if (data.lessons.length > MAX_ENTRIES) {
    data.lessons = data.lessons.slice(-MAX_ENTRIES);
  }

  save(data);
}

export function getRecentLessons(days = 7) {
  const data = load();
  return data.lessons.slice(-days);
}
