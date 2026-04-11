import { generateDailyReview } from "./goyimChat.js";
import { esc } from "./telegramBot.js";

let schedulerStarted = false;

function getNextReviewTime() {
  const now = new Date();
  const next = new Date();
  next.setHours(20, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

export function startDailyReviewScheduler(bot, chatId) {
  if (schedulerStarted) return;
  schedulerStarted = true;

  async function scheduleNext() {
    const next = getNextReviewTime();
    const delay = next.getTime() - Date.now();
    console.log(`📅 Daily review dijadwal: ${next.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}`);

    setTimeout(async () => {
      try {
        console.log("📋 Generating daily review...");
        const review = await generateDailyReview();

        const body = `<b>📋 Daily Review — Goyim Agent</b>\n\n${esc(review)}`;
        let sent;
        try {
          sent = await bot.telegram.sendMessage(chatId, body, { parse_mode: "HTML" });
        } catch (err) {
          if (err.message?.includes("parse entities")) {
            sent = await bot.telegram.sendMessage(chatId, body.replace(/<[^>]*>/g, ""));
          } else { throw err; }
        }

        await bot.telegram.pinChatMessage(chatId, sent.message_id, {
          disable_notification: false
        });

        console.log("✅ Daily review terkirim dan di-pin!");
      } catch (err) {
        console.error("❌ Daily review error:", err.message);
      }
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}
