import 'dotenv/config';
import { Bot, session } from 'grammy';
import {
  Calendar,
  type CalendarContext,
  type CalendarOptions,
} from 'grammy-calendar';

// Extend your context
type MyContext = CalendarContext;
type SessionData = { calendarOptions: CalendarOptions };

// Create your bot and session middleware
const bot = new Bot<MyContext>(process.env.BOT_TOKEN!);
bot.use(session({ initial: (): SessionData => ({ calendarOptions: {} }) }));

// Initialize the calendar middleware
const calendar = new Calendar<MyContext>(ctx => ctx.session.calendarOptions);
bot.use(calendar);

// Trigger showing the calendar
bot.command('pickdate', async ctx => {
  // Optionally set the default month/year:
  ctx.session.calendarOptions = { defaultDate: new Date() };
  // Reply with inline calendar keyboard
  await ctx.reply('Please select a date:', { reply_markup: calendar });
});

// Handle when a date is picked
bot.filter((ctx): ctx is MyContext & { calendarSelectedDate: Date } =>
  !!ctx.calendarSelectedDate,
async ctx => {
  const date = ctx.calendarSelectedDate!;
  await ctx.reply(`You selected: ${date.toDateString()}`);
});

bot.start();
