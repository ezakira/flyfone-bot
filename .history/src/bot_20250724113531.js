import 'dotenv/config';
import { Bot, session } from 'grammy';
import { Calendar, type CalendarContext, type CalendarOptions } from 'grammy-calendar';

// Extend the context to include calendar state
type MyContext = CalendarContext;
type SessionData = { calendarOptions?: CalendarOptions };

const bot = new Bot<MyContext>(process.env.BOT_TOKEN);
bot.use(session({ initial: (): SessionData => ({ calendarOptions: {} }) }));

// Initialize the calendar middleware
const calendar = new Calendar<MyContext>((ctx) => ctx.session.calendarOptions!);
bot.use(calendar);

// Guide user to pick date
bot.command('pickdate', async (ctx) => {
  ctx.session.calendarOptions = { defaultDate: new Date() };
  await ctx.reply('Please select a date:', { reply_markup: calendar }); // renders inline calendar
});

// Handle date selection
bot.filter((ctx): ctx is MyContext & { calendarSelectedDate: Date } => 
  !!ctx.calendarSelectedDate, async (ctx) => {
  const date = ctx.calendarSelectedDate!;
  await ctx.reply(`You selected: ${date.toDateString()}`);
});
