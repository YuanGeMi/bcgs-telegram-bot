import { GrammyError, type Bot, type InlineKeyboard } from 'grammy';
import type { Message } from 'grammy/types';
import type { NavAction } from '../callback-data';
import type { BotContext } from '../context';
import { CAPTION_MAX, clipText, pagerRow, rankingsKeyboard, sendScreen, type Screen } from '../inline-keyboards';
import {
  findCategory,
  getTopCasinos,
  getTopCasinosInCategory,
  type RankedCasino,
} from '../services/rankings';
import { getRankingsBanner, type RankingsBanner } from '../services/rankings-banner';
import { casinoUrl, formatRating } from '../site';
import { getLocale, t, type Locale } from '../i18n';

const PAGE_SIZE = 5;
/** Shortest a casino name is cut to in a caption before whole lines are dropped instead. */
const MIN_CAPTION_NAME = 8;
const FAILED_MEDIA_RETRY_MS = 10 * 60 * 1000;

function formatList(title: string, casinos: RankedCasino[], firstRank: number, locale: Locale): string {
  const entries = casinos.map((casino, index) =>
    t('rankings.rankedCasino', {
      rank: firstRank + index,
      name: casino.name,
      rating: formatRating(casino.overallRating, locale),
      url: casinoUrl(casino.slug, locale),
    }, locale),
  );
  return t('rankings.list', { title, entries: entries.join('\n\n') }, locale);
}

/**
 * The banner caption: the admin intro (if any), the page title, then one line per casino. Never over 1024:
 * long names are cut first, then lines are dropped from the bottom; the intro and title are always kept.
 */
export function formatCaption(intro: string, title: string, casinos: RankedCasino[], firstRank: number, locale: Locale): string {
  const header = clipText(intro ? `${intro}\n\n${title}` : title, CAPTION_MAX);
  const line = (index: number, name: string) => t('rankings.bannerLine', {
    rank: firstRank + index,
    name,
    rating: formatRating(casinos[index].overallRating, locale),
  }, locale);
  const join = (lines: string[]) => [header, ...lines].join('\n');

  const full = join(casinos.map((casino, index) => line(index, casino.name)));
  if (full.length <= CAPTION_MAX) return full;

  for (let count = casinos.length; count > 0; count -= 1) {
    const perLine = Math.floor((CAPTION_MAX - header.length - count) / count);
    const lines: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const nameRoom = perLine - line(index, '').length;
      if (nameRoom < MIN_CAPTION_NAME) break;
      lines.push(line(index, clipText(casinos[index].name, nameRoom)));
    }
    if (lines.length === count && join(lines).length <= CAPTION_MAX) return join(lines);
  }
  return header;
}

/**
 * One page of the overall rankings (empty `input`) or a category's (name or slug).
 * From a button (`fromButton`), a category or page that no longer exists returns null instead of an error text.
 * A page of casinos also gets a `caption` (with `intro` on top) for the banner message.
 */
export async function buildRankingsScreen(
  ctx: BotContext,
  input: string,
  page: number,
  locale: Locale,
  fromButton = false,
  intro = '',
): Promise<Screen | null> {
  const category = input ? await findCategory(input, locale) : null;
  if (input && !category) {
    return fromButton ? null : { text: t('rankings.categoryNotFound', { input }, locale) };
  }

  const casinos = category ? await getTopCasinosInCategory(category.id, locale) : await getTopCasinos(locale);
  if (casinos.length === 0) {
    if (fromButton && page > 1) return null;
    return {
      text: category
        ? t('rankings.noCategoryCasinos', { categoryName: category.name }, locale)
        : t('rankings.noCasinos', {}, locale),
    };
  }

  const pageCount = Math.ceil(casinos.length / PAGE_SIZE);
  if (page < 1 || page > pageCount) return null;

  const firstIndex = (page - 1) * PAGE_SIZE;
  const pageCasinos = casinos.slice(firstIndex, firstIndex + PAGE_SIZE);
  const title = category
    ? t('rankings.topCategory', { count: casinos.length, categoryName: category.name }, locale)
    : t('rankings.topOverall', { count: casinos.length }, locale);
  const categorySlug = category?.slug;
  const toPage = (target: number): NavAction => ({ kind: 'rankingsPage', page: target, category: categorySlug });

  return {
    text: formatList(title, pageCasinos, firstIndex + 1, locale),
    caption: formatCaption(intro, title, pageCasinos, firstIndex + 1, locale),
    keyboard: rankingsKeyboard(
      pageCasinos.map((casino, index) => ({ slug: casino.slug, label: `${firstIndex + index + 1}. ${casino.name}` })),
      (slug) => ({ kind: 'rankingsCard', page, slug, category: categorySlug }),
      pagerRow(page, pageCount, toPage, locale),
    ),
  };
}

/** The banner for the user's language (else English), or null; a load failure counts as no banner. */
export async function loadRankingsBanner(locale: Locale): Promise<RankingsBanner | null> {
  try {
    return await getRankingsBanner(locale);
  } catch {
    console.warn('Loading the rankings banner failed; using the text rankings.');
    return null;
  }
}

/** Media URLs Telegram refused, with when to try them again. */
const failedMedia = new Map<string, number>();
/** Telegram's file_id per media type and URL, reused after the first successful send. */
const mediaFileIds = new Map<string, string>();

/** Short reason for logs, never with a URL. */
function describeError(error: unknown): string {
  const candidate = error as { error_code?: unknown; description?: unknown; message?: unknown };
  const detail = candidate?.description ?? candidate?.message ?? String(error);
  const code = typeof candidate?.error_code === 'number' ? `${candidate.error_code} ` : '';
  return `${code}${String(detail)}`.replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);
}

function sentFileId(message: Message, type: RankingsBanner['media']['type']): string | undefined {
  if (type === 'photo') return message.photo?.at(-1)?.file_id;
  if (type === 'animation') return message.animation?.file_id;
  return message.video?.file_id;
}

function sendMedia(
  ctx: BotContext,
  type: RankingsBanner['media']['type'],
  media: string,
  caption: string,
  keyboard: InlineKeyboard | undefined,
): Promise<Message> {
  const other = { caption, reply_markup: keyboard };
  if (type === 'photo') return ctx.replyWithPhoto(media, other);
  if (type === 'animation') return ctx.replyWithAnimation(media, other);
  return ctx.replyWithVideo(media, other);
}

/** Sends the banner with the caption and buttons; false (after a short warning) if it couldn't be sent. */
async function sendBanner(
  ctx: BotContext,
  banner: RankingsBanner,
  caption: string,
  keyboard: InlineKeyboard | undefined,
): Promise<boolean> {
  const { url, type } = banner.media;
  const retryAt = failedMedia.get(url);
  if (retryAt !== undefined) {
    if (Date.now() < retryAt) return false;
    failedMedia.delete(url);
  }

  const cacheKey = `${type} ${url}`;
  const fileId = mediaFileIds.get(cacheKey);
  if (fileId) {
    try {
      await sendMedia(ctx, type, fileId, caption, keyboard);
      return true;
    } catch (error) {
      mediaFileIds.delete(cacheKey);
      console.warn(`Rankings banner ${type} file_id was refused: ${describeError(error)}`);
    }
  }

  try {
    const message = await sendMedia(ctx, type, url, caption, keyboard);
    const newFileId = sentFileId(message, type);
    if (newFileId) mediaFileIds.set(cacheKey, newFileId);
    return true;
  } catch (error) {
    if (error instanceof GrammyError && error.error_code === 400) failedMedia.set(url, Date.now() + FAILED_MEDIA_RETRY_MS);
    console.warn(`Rankings banner ${type} could not be sent: ${describeError(error)}`);
    return false;
  }
}

/** /rankings: the banner with the page in its caption when one is set, otherwise (or if it fails) the text rankings. */
export async function replyRankings(ctx: BotContext, input: string): Promise<void> {
  const locale = getLocale(ctx);
  try {
    const banner = await loadRankingsBanner(locale);
    const screen = await buildRankingsScreen(ctx, input, 1, locale, false, banner?.introText);
    if (!screen) return;
    if (banner && screen.caption && (await sendBanner(ctx, banner, screen.caption, screen.keyboard))) return;
    await sendScreen(ctx, screen);
  } catch (error) {
    console.error('/rankings failed.');
    await ctx.reply(t('common.genericError', {}, locale));
  }
}

export function registerRankingsCommand(bot: Bot<BotContext>) {
  bot.command('rankings', (ctx) => replyRankings(ctx, ctx.match.trim()));
}
