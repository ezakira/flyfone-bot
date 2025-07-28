import 'dotenv/config';
import { Bot } from 'grammy';
import { Calendar } from '@grammyjs/calendar';

const bot = new Bot(process.env.BOT_TOKEN);

// Initialize the calendar extension
const calendar = new Calendar(bot, {
  // how dates appear to the user
  dateFormat: 'YYYY-MM-DD',
  // language for month/day names
  language: 'en',
});

// Command to start the picker
bot.command('pickdate', ctx => {
  // send the calendar as an inline keyboard
  calendar.sendDatePicker(ctx.chat.id);
});

// Handle the button clicks
bot.on('callback_query:data', async ctx => {
  // Try to parse the callback as a date selection
  const date = calendar.parseDate(ctx.callbackQuery.data);
  if (date) {
    // user picked a date
    await ctx.api.sendMessage(
      ctx.chat.id,
      `You picked: ${date.toLocaleDateString()}`,
    );
  } else {
    // it might be a month‑nav button
    await calendar.updateDatePicker(ctx);
  }
});

bot.start();
