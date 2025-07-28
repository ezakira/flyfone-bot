import 'dotenv/config';
import { Bot, session } from 'grammy';
import { Calendar } from 'grammy-calendar';

// Create the bot
const bot = new Bot(process.env.BOT_TOKEN);

// Add session middleware (needed by the calendar for storing its state)
bot.use(session({
  initial: () => ({ calendarOptions: {} })
}));

// Initialize the calendar and wire it into your middleware stack
const calendar = new Calendar(ctx => ctx.session.calendarOptions);
bot.use(calendar);

// /pickdate → show the inline calendar
bot.command('pickdate', async ctx => {
  // Optionally pick a starting month/year
  ctx.session.calendarOptions = { defaultDate: new Date() };
  await ctx.reply('Please select a date:', {
    reply_markup: calendar
  });
});

// When the user taps a day, `ctx.calendarSelectedDate` is set.
// We filter for that and send the final confirmation.
bot.filter(ctx => ctx.calendarSelectedDate, async ctx => {
  const picked = ctx.calendarSelectedDate;  // JS Date object
  await ctx.reply(`✅ You picked: ${picked.toDateString()}`);
});

// Graceful error logging
bot.catch((err, ctx) => {
  console.error('Bot error', err, 'while handling update', ctx.update);
});

// Start the bot
bot.start({
  onStart: info => console.log(`Bot started as @${info.username}`)
});
