import { GrammyError, InlineKeyboard } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { complaintStartParameter, encodeNav, type CardAction, type NavAction } from './callback-data';
import type { BotContext } from './context';
import type { Messages } from './i18n/en';
import { t, type Locale } from './i18n';
import { casinoUrl } from './site';

/** A message body plus its buttons, so the same screen can be sent fresh or edited in place. */
export type Screen = {
  text: string;
  keyboard?: InlineKeyboard;
  /** Send as a reply to the user's message: Back on a list re-reads the query from it. */
  replyToQuery?: boolean;
  /** Used instead of `text` when the screen goes on a media message; defaults to `text` cut to fit a caption. */
  caption?: string;
};

/** Telegram's media caption limit. */
export const CAPTION_MAX = 1024;

/** Cuts to `max` with an ellipsis, never splitting a surrogate pair. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max - 1));
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** True for a photo, GIF or video message, whose text is a caption. */
export function isMediaMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  return 'photo' in message || 'animation' in message || 'video' in message;
}

type ButtonKey = Exclude<keyof Messages['buttons'], 'unavailable'>;

const EMOJI: Record<ButtonKey, string> = {
  viewReview: '📖',
  visitWebsite: '🌐',
  submitComplaint: '📝',
  complaintShort: '📝',
  back: '⬅️',
  previous: '◀️',
  next: '▶️',
  website: '🌐',
  community: '💬',
  discord: '🎮',
};

type Row = InlineKeyboardButton[];

function label(key: ButtonKey, locale: Locale): string {
  return `${EMOJI[key]} ${t(`buttons.${key}`, {}, locale)}`;
}

function navButton(text: string, action: NavAction): InlineKeyboardButton | null {
  const data = encodeNav(action);
  return data ? InlineKeyboard.text(text, data) : null;
}

function urlButton(text: string, url: string | undefined): InlineKeyboardButton | null {
  return url ? InlineKeyboard.url(text, url) : null;
}

/** Drops missing buttons and empty rows; undefined when nothing is left. */
function keyboard(rows: (InlineKeyboardButton | null)[][]): InlineKeyboard | undefined {
  const kept = rows.map((row) => row.filter((button): button is InlineKeyboardButton => button !== null)).filter((row) => row.length > 0);
  return kept.length > 0 ? InlineKeyboard.from(kept as Row[]) : undefined;
}

/**
 * Starts the flow with this casino preselected. In private chats it starts it directly; in groups it
 * deep-links to the private chat, never starting the flow there.
 */
function complaintButton(
  ctx: BotContext,
  slug: string,
  locale: Locale,
  key: 'submitComplaint' | 'complaintShort' = 'submitComplaint',
): InlineKeyboardButton | null {
  const text = label(key, locale);
  if (ctx.chat?.type === 'private') return navButton(text, { kind: 'complaint', slug });
  return urlButton(text, ctx.me.username ? `https://t.me/${ctx.me.username}?start=${complaintStartParameter(slug)}` : undefined);
}

function backRow(back: NavAction | undefined, locale: Locale): (InlineKeyboardButton | null)[] {
  return back ? [navButton(label('back', locale), back)] : [];
}

/** Read Review opens the review in this message; Visit Website is the casino's BC.GS page. */
export function casinoCardKeyboard(ctx: BotContext, card: CardAction, locale: Locale, back?: NavAction) {
  return keyboard([
    [
      navButton(label('viewReview', locale), { kind: 'cardReview', card }),
      urlButton(label('visitWebsite', locale), casinoUrl(card.slug, locale)),
    ],
    [complaintButton(ctx, card.slug, locale)],
    backRow(back, locale),
  ]);
}

/** Visit Website and Complaint share a row (short complaint label); without a website URL, Complaint is alone. */
export function reviewKeyboard(
  ctx: BotContext,
  slug: string,
  locale: Locale,
  back?: NavAction,
  websiteUrl: string | undefined = casinoUrl(slug, locale),
) {
  return keyboard([
    [urlButton(label('visitWebsite', locale), websiteUrl), complaintButton(ctx, slug, locale, 'complaintShort')],
    backRow(back, locale),
  ]);
}

/** One casino per row; the label is the casino name, the data only its slug. */
export function casinoListKeyboard(casinos: { slug: string; label: string }[], open: (slug: string) => NavAction) {
  return keyboard(casinos.map((casino) => [navButton(casino.label, open(casino.slug))]));
}

export function pagerRow(page: number, pageCount: number, toPage: (page: number) => NavAction, locale: Locale) {
  return [
    page > 1 ? navButton(label('previous', locale), toPage(page - 1)) : null,
    page < pageCount ? navButton(label('next', locale), toPage(page + 1)) : null,
  ];
}

export function rankingsKeyboard(
  casinos: { slug: string; label: string }[],
  open: (slug: string) => NavAction,
  pager: (InlineKeyboardButton | null)[],
) {
  return keyboard([...casinos.map((casino) => [navButton(casino.label, open(casino.slug))]), pager]);
}

export function linksKeyboard(links: { website: string; community?: string; discord?: string }, locale: Locale) {
  return keyboard([
    [urlButton(label('website', locale), links.website), urlButton(label('community', locale), links.community)],
    [urlButton(label('discord', locale), links.discord)],
  ]);
}

export async function sendScreen(ctx: BotContext, screen: Screen): Promise<void> {
  const messageId = ctx.message?.message_id;
  await ctx.reply(screen.text, {
    reply_markup: screen.keyboard,
    link_preview_options: { is_disabled: true },
    ...(screen.replyToQuery && messageId
      ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } }
      : {}),
  });
}

function messageCaption(message: unknown): string | undefined {
  if (!message || typeof message !== 'object' || !('caption' in message)) return undefined;
  const caption = (message as { caption?: unknown }).caption;
  return typeof caption === 'string' ? caption : undefined;
}

/**
 * Replaces the tapped message with `screen`: the caption of a media message (the media stays), else the text.
 * A media message whose caption is already the new one only gets new buttons.
 * Sends it as a new text message if the old one can't be edited.
 */
export async function editScreen(ctx: BotContext, screen: Screen): Promise<void> {
  try {
    if (isMediaMessage(ctx.callbackQuery?.message)) {
      const caption = screen.caption ?? clipText(screen.text, CAPTION_MAX);
      if (messageCaption(ctx.callbackQuery?.message) === caption) {
        await ctx.editMessageReplyMarkup({ reply_markup: screen.keyboard });
      } else {
        await ctx.editMessageCaption({ caption, reply_markup: screen.keyboard });
      }
    } else {
      await ctx.editMessageText(screen.text, {
        reply_markup: screen.keyboard,
        link_preview_options: { is_disabled: true },
      });
    }
  } catch (error) {
    if (error instanceof GrammyError && /message is not modified/i.test(error.description)) return;
    await ctx.reply(screen.text, { reply_markup: screen.keyboard, link_preview_options: { is_disabled: true } });
  }
}
