import type { Bot } from 'grammy';
import type { NavAction } from '../callback-data';
import type { BotContext } from '../context';
import { casinoListKeyboard, reviewKeyboard, sendScreen, type Screen } from '../inline-keyboards';
import { getCasinoBySlug, searchCasinos, type CasinoMatch } from '../services/casinos';
import { getCasinoReviewSummary } from '../services/reviews';
import { casinoUrl, formatRating } from '../site';
import { getLocale, t, type Locale } from '../i18n';

const MESSAGE_LIMIT = 4096;

const EDITORIAL_PREVIEW = 500;
const USER_REVIEW_PREVIEW = 200;

/** Cuts at the last word break that fits and adds an ellipsis. */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, Math.max(0, maxLength - 1));
  const wordBreak = slice.search(/\s\S*$/);
  return `${(wordBreak > maxLength / 2 ? slice.slice(0, wordBreak) : slice).trimEnd()}…`;
}

/** Keeps whole lines from the top until `footer` still fits within the message limit. */
function fitWithFooter(lines: string[], footer: string): string {
  const kept: string[] = [];
  let length = footer.length + 2;
  for (const line of lines) {
    if (length + line.length + 1 > MESSAGE_LIMIT) {
      const room = MESSAGE_LIMIT - length - 1;
      if (room > 40) kept.push(truncate(line, room));
      break;
    }
    kept.push(line);
    length += line.length + 1;
  }
  while (kept.length > 0 && !kept.at(-1)!.trim()) kept.pop();
  return [...kept, '', footer].join('\n');
}

function renderReviewReply(
  casino: CasinoMatch,
  summary: Awaited<ReturnType<typeof getCasinoReviewSummary>>,
  locale: Locale,
): string {
  const link = casinoUrl(casino.slug, locale);
  const lines = [casino.name, t('review.overallRating', { rating: formatRating(casino.overallRating, locale) }, locale)];

  let shortened = false;
  if (summary.editorialSummary) {
    shortened = summary.editorialSummary.length > EDITORIAL_PREVIEW;
    lines.push('', t('review.editorialSummary', {}, locale), truncate(summary.editorialSummary, EDITORIAL_PREVIEW));
  }

  lines.push(
    '',
    t('review.userRating', {
      rating: formatRating(summary.userRatingAvg, locale),
      count: summary.userRatingCount,
    }, locale),
  );

  if (summary.latestReviews.length > 0) {
    lines.push('', t('review.latestReviews', {}, locale));
    for (const review of summary.latestReviews) {
      const author = review.authorName ? ` — ${review.authorName}` : '';
      lines.push(t('review.singleReview', {
        rating: review.rating,
        author,
        body: truncate(review.body, USER_REVIEW_PREVIEW),
      }, locale));
    }
  } else if (!summary.editorialSummary) {
    lines.push('', t('review.noReviews', {}, locale));
  }

  const readFull = t('review.readFull', { url: link }, locale);
  const reply = [...lines, '', shortened ? readFull : link].join('\n');
  return reply.length <= MESSAGE_LIMIT ? reply : fitWithFooter(lines, readFull);
}

async function casinoReviewScreen(
  ctx: BotContext,
  casino: CasinoMatch,
  locale: Locale,
  back?: NavAction,
): Promise<Screen> {
  const summary = await getCasinoReviewSummary(casino.id, locale);
  return { text: renderReviewReply(casino, summary, locale), keyboard: reviewKeyboard(ctx, casino.slug, locale, back) };
}

export async function buildReviewScreen(ctx: BotContext, query: string, locale: Locale): Promise<Screen> {
  const { matches: casinos, suggestions } = await searchCasinos(query, 5, locale);
  if (casinos.length === 0) {
    return {
      text: suggestions.length > 0
        ? t('review.didYouMean', { names: suggestions.join('\n') }, locale)
        : t('review.noResults', {}, locale),
    };
  }

  const exactMatch = casinos.find((casino) => casino.matchType === 'exact');

  if (casinos.length > 1 && !exactMatch) {
    return {
      text: t('review.chooseSpecific', { names: casinos.map((casino) => casino.name).join('\n') }, locale),
      keyboard: casinoListKeyboard(
        casinos.map((casino) => ({ slug: casino.slug, label: casino.name })),
        (slug) => ({ kind: 'reviewOpen', slug }),
      ),
      replyToQuery: true,
    };
  }

  return casinoReviewScreen(ctx, exactMatch ?? casinos[0], locale);
}

/** A casino review opened from a button, with Back to where it came from (if given); null if the casino is gone. */
export async function buildReviewScreenBySlug(
  ctx: BotContext,
  slug: string,
  locale: Locale,
  back?: NavAction,
): Promise<Screen | null> {
  const casino = await getCasinoBySlug(slug, locale);
  return casino ? casinoReviewScreen(ctx, casino, locale, back) : null;
}

export async function replyReview(ctx: BotContext, query: string): Promise<void> {
  const locale = getLocale(ctx);

  if (!query) {
    await ctx.reply(t('review.usage', {}, locale));
    return;
  }

  try {
    await sendScreen(ctx, await buildReviewScreen(ctx, query, locale));
  } catch (error) {
    console.error('/review failed.');
    await ctx.reply(t('common.genericError', {}, locale));
  }
}

export function registerReviewCommand(bot: Bot<BotContext>) {
  bot.command('review', (ctx) => replyReview(ctx, ctx.match.trim()));
}
