import 'dotenv/config';
import { Bot } from 'grammy';
import { Calendar } from 'telegram-inline-calendar';

const bot = new Bot(process.env.BOT_TOKEN);
const calendar = new Calendar(bot, {
  date_format: 'YYYY-MM-DD',
  language: 'en',
});

bot.command('pickdate', ctx => calendar.startNavCalendar(ctx));

bot.on('callback_query:data', async ctx => {
  const res = calendar.clickButtonCalendar(ctx.callbackQuery);
  if (res !== -1) {
    await ctx.reply(`You selected: ${res}`);
  }
});

bot.start();
