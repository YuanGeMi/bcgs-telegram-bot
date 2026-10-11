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

/** "Welcome Ana" with the bottom keyboard, as plain text. A failure is logged and never blocks the welcome. */
async function sendGreeting(ctx: BotContext, locale: Locale): Promise<void> {
  const name = Array.from(cleanName(ctx.from?.first_name)).slice(0, GREETING_NAME_MAX).join('').trimEnd();
  const text = name ? t('app.greeting', { name }, locale) : t('app.greetingNoName', {}, locale);
  try {
    await ctx.reply(text, { reply_markup: mainKeyboard(locale) });
  } catch (error) {
    console.warn(`Welcome greeting (${locale}) could not be sent: ${describeError(error)}`);
  }
}

type CustomWelcomeResult = { sent: false } | { sent: true; keyboardMissing: boolean };

/**
 * Sends the admin-edited welcome as plain text (no parse mode), in up to two messages:
 * the welcome text, then the media with its own caption. The inline buttons, or the bottom
 * keyboard when there are none, go on the last message actually sent. With inline buttons,
 * the bottom keyboard goes on a short greeting sent before the welcome instead.
 */
async function sendCustomWelcome(ctx: BotContext, welcome: Welcome, locale: Locale): Promise<CustomWelcomeResult> {
  const user = { firstName: ctx.from?.first_name, lastName: ctx.from?.last_name, username: ctx.from?.username };
  const fallbackName = t('app.nameFallback', {}, locale);
  const text = welcome.text ? renderWelcomeTemplate(welcome.text, user, fallbackName, WELCOME_TEXT_MAX) : '';
  const caption = welcome.caption ? renderWelcomeTemplate(welcome.caption, user, fallbackName, WELCOME_CAPTION_MAX) : '';

  const inline = welcome.buttons.length
    ? InlineKeyboard.from(welcome.buttons.map((button) => [InlineKeyboard.url(button.label, button.url)]))
    : null;
  // One keyboard per message: without inline buttons the bottom keyboard rides on the last welcome message.
  const markup = inline ?? mainKeyboard(locale);
  if (inline) await sendGreeting(ctx, locale);

  let textMessageId: number | null = null;
  if (text) {
    try {
      const message = await ctx.reply(text, welcome.media ? {} : { reply_markup: markup });
      textMessageId = message.message_id;
    } catch (error) {
      console.warn(`Welcome text (${locale}) could not be sent: ${describeError(error)}`);
    }
  }

  if (!welcome.media) {
    return textMessageId === null ? { sent: false } : { sent: true, keyboardMissing: false };
  }

  try {
    await sendMedia(ctx, welcome.media, caption, markup);
    return { sent: true, keyboardMissing: false };
  } catch (error) {
    console.warn(`Welcome ${welcome.media.type} (${locale}) could not be sent: ${describeError(error)}`);
  }

  if (textMessageId === null || !ctx.chat) return { sent: false };
  // The media failed after the text went out: the text is now the last message, so the buttons move onto it.
  // Only inline keyboards can be added by editing; without a greeting the bottom keyboard needs the follow-up message.
  if (!inline) return { sent: true, keyboardMissing: true };
  try {
    await ctx.api.editMessageReplyMarkup(ctx.chat.id, textMessageId, { reply_markup: inline });
  } catch (error) {
    console.warn(`Welcome buttons (${locale}) could not be added to the text: ${describeError(error)}`);
  }
  return { sent: true, keyboardMissing: false };
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
