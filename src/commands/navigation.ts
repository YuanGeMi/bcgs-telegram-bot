import type { Bot } from 'grammy';
import { decodeNav, type NavAction } from '../callback-data';
import type { BotContext } from '../context';
import { getLocale, t, type Locale } from '../i18n';
import { editScreen, isMediaMessage, sendScreen, type Screen } from '../inline-keyboards';
import { startComplaintFlow } from './complaint';
import { buildRankingsScreen, loadRankingsBanner } from './rankings';
import { buildReviewScreen, buildReviewScreenBySlug } from './review';
import { buildCasinoCardScreen, buildSearchScreen } from './search';

/** The query of the /search or /review message a list replied to, without the command itself. */
function repliedQuery(ctx: BotContext): string | null {
  const message = ctx.callbackQuery?.message;
  const text = message && 'reply_to_message' in message ? message.reply_to_message?.text : undefined;
  const query = text?.replace(/^\/\S+\s*/, '').trim();
  return query || null;
}

async function screenFor(ctx: BotContext, action: NavAction, locale: Locale, onMedia: boolean): Promise<Screen | null> {
  switch (action.kind) {
    case 'card':
    case 'searchCard':
    case 'rankingsCard':
      return buildCasinoCardScreen(ctx, action, locale);
    case 'cardReview':
      return buildReviewScreenBySlug(ctx, action.card.slug, locale, action.card);
    case 'searchBack': {
      const query = repliedQuery(ctx);
      return query ? buildSearchScreen(ctx, query, locale) : null;
    }
    case 'reviewOpen':
      return buildReviewScreenBySlug(ctx, action.slug, locale, { kind: 'reviewBack' });
    case 'reviewBack': {
      const query = repliedQuery(ctx);
      return query ? buildReviewScreen(ctx, query, locale) : null;
    }
    case 'rankingsPage': {
      const intro = onMedia ? (await loadRankingsBanner(locale))?.introText : undefined;
      return buildRankingsScreen(ctx, action.category ?? '', action.page, locale, true, intro);
    }
    case 'complaint':
      return null;
  }
}

/** Register after every other callback handler: it also answers taps nothing else recognized. */
export function registerNavigation(bot: Bot<BotContext>) {
  bot.on('callback_query:data', async (ctx, next) => {
    const action = decodeNav(ctx.callbackQuery.data);
    if (!action) return next();
    const locale = getLocale(ctx);

    try {
      if (action.kind === 'complaint') {
        await ctx.answerCallbackQuery();
        // Groups only ever get a URL button; startComplaintFlow still refuses to run the flow outside private chats.
        await startComplaintFlow(ctx, 'complaint', action.slug);
        return;
      }

      // Buttons on the rankings banner edit its caption, or only its buttons when the caption stays; the same buttons on an older text message edit the text.
      const onMedia = isMediaMessage(ctx.callbackQuery.message);
      if (action.kind === 'cardReview' && onMedia) {
        // A review doesn't fit in a caption: it goes out as a new message below the banner, which stays as it is.
        const review = await buildReviewScreenBySlug(ctx, action.card.slug, locale);
        if (!review) {
          await ctx.answerCallbackQuery({ text: t('buttons.unavailable', {}, locale) });
          return;
        }
        await ctx.answerCallbackQuery();
        await sendScreen(ctx, review);
        return;
      }

      const screen = await screenFor(ctx, action, locale, onMedia);
      if (!screen) {
        await ctx.answerCallbackQuery({ text: t('buttons.unavailable', {}, locale) });
        return;
      }
      await editScreen(ctx, screen);
      await ctx.answerCallbackQuery();
    } catch (error) {
      console.error('Inline button failed.');
      await ctx.answerCallbackQuery({ text: t('common.genericError', {}, locale) }).catch(() => {});
    }
  });

  bot.on('callback_query', (ctx) =>
    ctx.answerCallbackQuery({ text: t('buttons.unavailable', {}, getLocale(ctx)) }),
  );
}
