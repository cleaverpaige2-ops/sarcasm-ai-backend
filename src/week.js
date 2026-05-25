// src/week.js
export function getWeekKey(d = new Date()) {
  // ISO week key like 2026-W05 (UTC-based)
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  const yyyy = date.getUTCFullYear();
  const ww = String(weekNo).padStart(2, "0");
  return `${yyyy}-W${ww}`;
}

export function daysUntilNextWeek() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  const daysToNextMon = 8 - dayNum;
  d.setUTCDate(d.getUTCDate() + daysToNextMon);
  const diffMs = d.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diffMs / 86400000));
}