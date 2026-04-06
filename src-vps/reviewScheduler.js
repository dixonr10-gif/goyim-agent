import { generateDailyReview } from "./goyimChat.js";

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

        // Kirim review
        const sent = await bot.telegram.sendMessage(chatId,
          `<b>📋 Daily Review — Goyim Agent</b>\n\n${review}`,
          { parse_mode: "HTML" }
        );

        // Pin pesan
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
