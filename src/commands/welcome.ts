import { InlineKeyboard, type Keyboard } from 'grammy';
import type { BotContext } from '../context';
import { t, type Locale } from '../i18n';
import { mainKeyboard, replyWithMainMenu } from '../keyboard';
import { getWelcome, WELCOME_CAPTION_MAX, WELCOME_TEXT_MAX, type Welcome } from '../services/welcome';
import { cleanName, renderWelcomeTemplate } from '../services/welcome-placeholders';
import { buildHelpReply } from './help';

const GREETING_NAME_MAX = 64;

/** Short reason for logs. Telegram errors don't carry the media URL, but strip any URL just in case. */
function describeError(error: unknown): string {
  const candidate = error as { error_code?: unknown; description?: unknown; message?: unknown };
  const detail = candidate?.description ?? candidate?.message ?? String(error);
  const code = typeof candidate?.error_code === 'number' ? `${candidate.error_code} ` : '';
  return `${code}${String(detail)}`.replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);
}

function sendMedia(
  ctx: BotContext,
  media: NonNullable<Welcome['media']>,
  caption: string,
  markup: InlineKeyboard | Keyboard,
) {
  const other = { ...(caption ? { caption } : {}), reply_markup: markup };
  if (media.type === 'photo') return ctx.replyWithPhoto(media.url, other);
  if (media.type === 'animation') return ctx.replyWithAnimation(media.url, other);
  return ctx.replyWithVideo(media.url, other);
}

/** Runs one send; a failure is logged as a short warning and reported as false, never thrown. */
async function trySend(label: string, locale: Locale, send: () => Promise<unknown>): Promise<boolean> {
  try {
    await send();
    return true;
  } catch (error) {
    console.warn(`Welcome ${label} (${locale}) could not be sent: ${describeError(error)}`);
    return false;
  }
}

/** "Welcome Ana", the keyboard carrier when the admin welcome has buttons but no text. */
function greetingText(ctx: BotContext, locale: Locale): string {
  const name = Array.from(cleanName(ctx.from?.first_name)).slice(0, GREETING_NAME_MAX).join('').trimEnd();
  return name ? t('app.greeting', { name }, locale) : t('app.greetingNoName', {}, locale);
}

type CustomWelcomeResult = { sent: false } | { sent: true; keyboardMissing: boolean };

/**
 * Sends the admin-edited welcome as plain text (no parse mode). One keyboard fits on a message, so:
 * - no inline buttons: the welcome text, then the media with its caption; the bottom keyboard rides
 *   on the last message sent.
 * - inline buttons: the welcome text (or, without text, a short greeting) carries the bottom keyboard,
 *   then the media carries the caption and the buttons. Without media, or if it fails, a short
 *   "links" message carries the buttons.
 */
async function sendCustomWelcome(ctx: BotContext, welcome: Welcome, locale: Locale): Promise<CustomWelcomeResult> {
  const user = { firstName: ctx.from?.first_name, lastName: ctx.from?.last_name, username: ctx.from?.username };
  const fallbackName = t('app.nameFallback', {}, locale);
  const text = welcome.text ? renderWelcomeTemplate(welcome.text, user, fallbackName, WELCOME_TEXT_MAX) : '';
  const caption = welcome.caption ? renderWelcomeTemplate(welcome.caption, user, fallbackName, WELCOME_CAPTION_MAX) : '';
  const keyboard = mainKeyboard(locale);
  const media = welcome.media;

  if (!welcome.buttons.length) {
    const textSent = text
      ? await trySend('text', locale, () => ctx.reply(text, media ? {} : { reply_markup: keyboard }))
      : false;
    if (!media) return textSent ? { sent: true, keyboardMissing: false } : { sent: false };
    if (await trySend(media.type, locale, () => sendMedia(ctx, media, caption, keyboard))) {
      return { sent: true, keyboardMissing: false };
    }
    return textSent ? { sent: true, keyboardMissing: true } : { sent: false };
  }

  const inline = InlineKeyboard.from(welcome.buttons.map((button) => [InlineKeyboard.url(button.label, button.url)]));
  let textSent = false;
  if (text) textSent = await trySend('text', locale, () => ctx.reply(text, { reply_markup: keyboard }));
  else await trySend('greeting', locale, () => ctx.reply(greetingText(ctx, locale), { reply_markup: keyboard }));

  if (media && (await trySend(media.type, locale, () => sendMedia(ctx, media, caption, inline)))) {
    return { sent: true, keyboardMissing: false };
  }
  // Media-only welcome whose media failed: the built-in welcome stands in, as before.
  if (!text) return { sent: false };
  const buttonsSent = await trySend('buttons', locale, () => ctx.reply(t('app.welcomeButtons', {}, locale), { reply_markup: inline }));
  return textSent || buttonsSent ? { sent: true, keyboardMissing: false } : { sent: false };
}

/** Private-chat welcome: the admin-edited one when set, otherwise the built-in help with the bottom keyboard. */
export async function sendWelcome(ctx: BotContext, locale: Locale): Promise<void> {
  let welcome: Welcome | null = null;
  try {
    welcome = await getWelcome(locale);
  } catch {
    console.warn('Loading the welcome message failed; using the built-in welcome.');
  }

  const result = welcome ? await sendCustomWelcome(ctx, welcome, locale) : { sent: false as const };
  if (!result.sent) {
    await replyWithMainMenu(ctx, buildHelpReply(false, locale));
    return;
  }
  if (result.keyboardMissing) await replyWithMainMenu(ctx, t('keyboard.ready', {}, locale));
}
