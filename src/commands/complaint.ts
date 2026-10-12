import { randomInt } from 'node:crypto';
import { conversations, createConversation, type Conversation } from '@grammyjs/conversations';
import { Prisma, type ReportType } from '@prisma/client';
import { InlineKeyboard, type Bot, type Context } from 'grammy';
import type { Message } from 'grammy/types';
import type { BotContext } from '../context';
import { prisma } from '../prisma';
import {
  complaintStartParameter,
  decodeFlowButton,
  encodeFlowButton,
  FLOW_CALLBACK_PATTERN,
  type FlowAnswer,
} from '../callback-data';
import { findCasinos, getCasinoBySlug } from '../services/casinos';
import { DEFAULT_LOCALE, getLocale, isKeyword, isLocale, t, type Locale, type MessageKey } from '../i18n';
import { menuActionFor } from '../keyboard';
import { countRecentComplaintsByUser } from '../services/complaints';

const CONVERSATION_ID = 'submission';
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_SUBMISSIONS_PER_WINDOW = 3;
const WINDOW_HOURS = 24;
const MAX_CASINO_CHOICES = 5;
const MAX_SUBJECT_LENGTH = 200;
const MAX_ATTACHMENTS = 10;
// Bot API getFile cannot download anything larger, so admins could never retrieve it.
const MAX_ATTACHMENT_MB = 20;
const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'pdf', 'mp4', 'txt']);
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'video/mp4',
  'text/plain',
]);
const SUMMARY_DETAILS_PREVIEW = 800;
const MAX_CASE_ID_ATTEMPTS = 5;
const ADMIN_SUBJECT_PREVIEW = 100;

const LABELS: Record<ReportType, MessageKey> = {
  complaint: 'complaint.typeComplaint',
  scam_report: 'complaint.typeReport',
};

type SubmissionConversation = Conversation<BotContext, Context>;

/** casinoName is in the user's language; adminCasinoName is the English name for the admin chat. */
type CasinoChoice = { casinoId: string | null; casinoName: string; adminCasinoName: string };

export type SubmissionData = {
  type: ReportType;
  casinoId: string | null;
  casinoName: string | null;
  telegramUserId: string;
  contactName: string | null;
  contactEmail: string | null;
  subject: string;
  description: string;
  evidenceUrls: string[];
};

class FlowCancelled extends Error {}

function isCancelCommand(text: string): boolean {
  return /^\/cancel(@\S+)?(\s|$)/i.test(text);
}

/**
 * One running flow. `id` goes into its buttons, so taps on buttons from an earlier flow are recognized;
 * `prompt` is the message whose buttons are still live (at most one at a time).
 */
type Flow = { id: string; userId: number; chatId: number; label: string; locale: Locale; prompt: number | null };

type FlowButton = { answer: FlowAnswer; text: string };

const EMPTY_KEYBOARD = { inline_keyboard: [] };

function flowLabel(key: 'yes' | 'no' | 'noneOfThese' | 'done' | 'skip' | 'confirm' | 'cancel', locale: Locale): string {
  const emoji = { yes: '✅', no: '❌', noneOfThese: '🚫', done: '✅', skip: '⏭️', confirm: '✅', cancel: '✖️' }[key];
  return `${emoji} ${t(`flowButtons.${key}`, {}, locale)}`;
}

function flowButton(answer: FlowAnswer, key: Parameters<typeof flowLabel>[0], locale: Locale): FlowButton {
  return { answer, text: flowLabel(key, locale) };
}

function cancelButton(locale: Locale): FlowButton {
  return flowButton('c', 'cancel', locale);
}

/** Removes the live buttons, so an answered question can't be tapped again. */
async function clearPrompt(ctx: Context, flow: Flow): Promise<void> {
  if (flow.prompt === null) return;
  const messageId = flow.prompt;
  flow.prompt = null;
  try {
    await ctx.api.editMessageReplyMarkup(flow.chatId, messageId, { reply_markup: EMPTY_KEYBOARD });
  } catch {}
}

/** Sends a question with its buttons (rows of up to two), replacing the previous question's buttons. */
async function ask(ctx: Context, flow: Flow, text: string, rows: FlowButton[][] = []): Promise<void> {
  await clearPrompt(ctx, flow);
  if (rows.length === 0) {
    await ctx.reply(text);
    return;
  }
  const keyboard = InlineKeyboard.from(
    rows.map((row) => row.map((button) => InlineKeyboard.text(button.text, encodeFlowButton(flow.id, button.answer)))),
  );
  const message = await ctx.reply(text, { reply_markup: keyboard });
  flow.prompt = message.message_id;
}

async function removeTappedButtons(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: EMPTY_KEYBOARD });
  } catch {}
}

/** A flow button from a flow that is over: short popup, buttons removed, nothing else. */
export async function answerEndedFlowButton(ctx: Context, locale: Locale): Promise<void> {
  await ctx.answerCallbackQuery({ text: t('complaint.flowEnded', {}, locale) });
  await removeTappedButtons(ctx);
}

/** Any other inline button tapped mid-flow is answered and pointed back at the flow; it never counts as an answer. */
async function rejectButtonTap(ctx: Context, label: string, locale: Locale): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.reply(t('complaint.middleOfFlow', { label }, locale));
}

type FlowInput = { kind: 'button'; answer: FlowAnswer } | { kind: 'message'; ctx: Context; message: Message };

/**
 * The next answer: a message, or a tap on one of `answers` of this flow. Cancel (button) ends the flow like /cancel.
 * Taps on other buttons never count as an answer.
 */
async function waitForInput(
  conversation: SubmissionConversation,
  flow: Flow,
  answers: FlowAnswer[],
  replyToOtherUpdates = true,
): Promise<FlowInput> {
  while (true) {
    const next = await conversation.wait();
    if (next.message) return { kind: 'message', ctx: next, message: next.message };

    const data = next.callbackQuery?.data;
    if (!next.callbackQuery) {
      if (replyToOtherUpdates) await next.reply(t('complaint.replyTextOrCancel', {}, flow.locale));
      continue;
    }
    const button = data ? decodeFlowButton(data) : null;
    if (!button) {
      await rejectButtonTap(next, flow.label, flow.locale);
      continue;
    }
    if (button.flowId !== flow.id || next.from?.id !== flow.userId) {
      await answerEndedFlowButton(next, flow.locale);
      continue;
    }
    if (button.answer === 'c') {
      await next.answerCallbackQuery();
      throw new FlowCancelled();
    }
    if (!answers.includes(button.answer)) {
      await next.answerCallbackQuery({ text: t('buttons.unavailable', {}, flow.locale) });
      await removeTappedButtons(next);
      continue;
    }
    await next.answerCallbackQuery();
    await clearPrompt(next, flow);
    return { kind: 'button', answer: button.answer };
  }
}

type TextOrButton = { kind: 'text'; text: string } | { kind: 'button'; answer: FlowAnswer };

async function waitForText(conversation: SubmissionConversation, flow: Flow, answers: FlowAnswer[] = []): Promise<TextOrButton> {
  while (true) {
    const input = await waitForInput(conversation, flow, answers);
    if (input.kind === 'button') return input;
    const text = input.message.text?.trim();
    if (text === undefined) {
      await input.ctx.reply(t('complaint.replyTextOrCancel', {}, flow.locale));
      continue;
    }

    if (isCancelCommand(text)) throw new FlowCancelled();
    if (text.startsWith('/') || menuActionFor(text)) {
      await input.ctx.reply(
        t('complaint.middleOfFlow', { label: flow.label }, flow.locale),
      );
      continue;
    }
    if (text) return { kind: 'text', text };
  }
}

/** A question with no answer buttons, only Cancel: the typed text. */
async function askForText(conversation: SubmissionConversation, ctx: Context, flow: Flow, prompt: string): Promise<string> {
  await ask(ctx, flow, prompt, [[cancelButton(flow.locale)]]);
  return waitForPlainText(conversation, flow);
}

async function waitForPlainText(conversation: SubmissionConversation, flow: Flow): Promise<string> {
  const answer = await waitForText(conversation, flow);
  // No answer buttons were offered, so only text gets here.
  return answer.kind === 'text' ? answer.text : '';
}

/** Yes/No (or Confirm/Cancel at the end); typed yes/no in any language still works. */
async function askYesNo(
  conversation: SubmissionConversation,
  ctx: Context,
  flow: Flow,
  prompt: string,
  style: 'yesNo' | 'confirm',
): Promise<boolean> {
  const { locale } = flow;
  await ask(ctx, flow, prompt, style === 'yesNo'
    ? [[flowButton('y', 'yes', locale), flowButton('n', 'no', locale)], [cancelButton(locale)]]
    : [[flowButton('ok', 'confirm', locale), cancelButton(locale)]]);
  while (true) {
    const answer = await waitForText(conversation, flow, style === 'yesNo' ? ['y', 'n'] : ['ok']);
    if (answer.kind === 'button') return answer.answer !== 'n';
    const text = answer.text.toLowerCase();
    if (isKeyword('yes', text) || isKeyword('no', text)) {
      await clearPrompt(ctx, flow);
      return isKeyword('yes', text);
    }
    await ctx.reply(t('complaint.yesNo', {}, locale));
  }
}

async function askCasino(
  conversation: SubmissionConversation,
  ctx: Context,
  flow: Flow,
): Promise<CasinoChoice> {
  const { locale } = flow;
  const input = await askForText(conversation, ctx, flow, t('complaint.askCasino', {}, locale));
  const unlisted: CasinoChoice = { casinoId: null, casinoName: input, adminCasinoName: input };

  const matches = await conversation.external(() => findCasinos(input, MAX_CASINO_CHOICES, locale));

  if (matches.length === 0) {
    await ask(ctx, flow, t('complaint.casinoNotFound', { input }, locale));
    return unlisted;
  }

  // Every path here still asks yes/no or for a number; a fuzzy match is never accepted on its own.
  const strongMatch =
    matches.length === 1
      ? matches[0]
      : matches.find((match) => match.matchType === 'exact');

  if (strongMatch) {
    const confirmed = await askYesNo(
      conversation,
      ctx,
      flow,
      t('complaint.confirmCasino', { casinoName: strongMatch.name }, locale),
      'yesNo',
    );
    if (confirmed) {
      return { casinoId: strongMatch.id, casinoName: strongMatch.name, adminCasinoName: strongMatch.englishName };
    }
    if (matches.length === 1) {
      await ctx.reply(t('complaint.recordCasino', { input }, locale));
      return unlisted;
    }
  }

  const list = matches.map((match, index) => `${index + 1}. ${match.name}`).join('\n');
  const choices = matches.map((match, index) => [{ answer: `p${index + 1}` as FlowAnswer, text: match.name }]);
  await ask(ctx, flow, t('complaint.foundCasinos', { list }, locale), [
    ...choices,
    [flowButton('x', 'noneOfThese', locale)],
    [cancelButton(locale)],
  ]);
  const pick = (index: number): CasinoChoice => {
    const match = matches[index];
    return { casinoId: match.id, casinoName: match.name, adminCasinoName: match.englishName };
  };

  while (true) {
    const answer = await waitForText(conversation, flow, [...choices.map((row) => row[0].answer), 'x']);
    if (answer.kind === 'button') {
      if (answer.answer !== 'x') return pick(Number(answer.answer.slice(1)) - 1);
      await ctx.reply(t('complaint.recordCasino', { input }, locale));
      return unlisted;
    }
    if (isKeyword('none', answer.text.toLowerCase())) {
      await clearPrompt(ctx, flow);
      await ctx.reply(t('complaint.recordCasino', { input }, locale));
      return unlisted;
    }
    const choice = Number(answer.text);
    if (Number.isInteger(choice) && choice >= 1 && choice <= matches.length) {
      await clearPrompt(ctx, flow);
      return pick(choice - 1);
    }
    await ctx.reply(t('complaint.chooseCasinoNumber', { count: matches.length }, locale));
  }
}

/** The published casino for a slug, as if the user had confirmed it; null (so the flow asks) if it's gone. */
async function findPreselectedCasino(slug: string, locale: Locale): Promise<CasinoChoice | null> {
  try {
    const casino = await getCasinoBySlug(slug, locale);
    return casino ? { casinoId: casino.id, casinoName: casino.name, adminCasinoName: casino.englishName } : null;
  } catch {
    console.warn('Could not look up the preselected casino.');
    return null;
  }
}

async function askSubject(
  conversation: SubmissionConversation,
  ctx: Context,
  flow: Flow,
): Promise<string> {
  const { locale } = flow;
  await ask(ctx, flow, t('complaint.askSubject', {}, locale), [[cancelButton(locale)]]);
  while (true) {
    const subject = await waitForPlainText(conversation, flow);
    if (subject.length <= MAX_SUBJECT_LENGTH && !subject.includes('\n')) return subject;
    await ctx.reply(
      t('complaint.subjectTooLong', { maxLength: MAX_SUBJECT_LENGTH }, locale),
    );
  }
}

type AttachmentCheck =
  | { kind: 'accepted'; fileId: string }
  | { kind: 'unsupported' }
  | { kind: 'tooLarge' }
  | { kind: 'none' };

function isAllowedDocument(document: { mime_type?: string; file_name?: string }): boolean {
  const mimeType = document.mime_type?.toLowerCase();
  const fileName = document.file_name?.toLowerCase() ?? '';
  const extension = fileName.includes('.') ? fileName.split('.').pop() : undefined;
  return (
    (mimeType !== undefined && ALLOWED_MIME_TYPES.has(mimeType)) ||
    (extension !== undefined && ALLOWED_EXTENSIONS.has(extension))
  );
}

function checkAttachment(message: Message): AttachmentCheck {
  const photo = message.photo?.at(-1);
  const document = message.document;
  const file = photo ?? document;

  if (!file) {
    const otherMedia =
      message.video ?? message.audio ?? message.voice ?? message.video_note ?? message.sticker;
    return otherMedia ? { kind: 'unsupported' } : { kind: 'none' };
  }
  if (!photo && document && !isAllowedDocument(document)) return { kind: 'unsupported' };
  if ((file.file_size ?? 0) > MAX_ATTACHMENT_BYTES) return { kind: 'tooLarge' };
  return { kind: 'accepted', fileId: file.file_id };
}

async function askEvidence(
  conversation: SubmissionConversation,
  ctx: Context,
  flow: Flow,
): Promise<string[]> {
  const { label, locale } = flow;
  await ask(ctx, flow, t('complaint.askEvidence', {}, locale), [
    [flowButton('d', 'done', locale), flowButton('s', 'skip', locale)],
    [cancelButton(locale)],
  ]);
  const evidence: string[] = [];

  while (true) {
    const input = await waitForInput(conversation, flow, ['d', 's'], false);
    if (input.kind === 'button') return evidence;
    const { ctx: next, message } = input;
    const attachment = checkAttachment(message);

    if (attachment.kind === 'unsupported') {
      await next.reply(t('complaint.unsupportedFile', {}, locale));
      continue;
    }
    if (attachment.kind === 'tooLarge') {
      await next.reply(t('complaint.fileTooLarge', { maxMb: MAX_ATTACHMENT_MB }, locale));
      continue;
    }
    if (attachment.kind === 'accepted') {
      // Bot API file URLs embed the bot token and expire, so store the permanent file_id instead.
      evidence.push(`tg-file:${attachment.fileId}`);
      if (evidence.length >= MAX_ATTACHMENTS) {
        await clearPrompt(ctx, flow);
        await next.reply(t('complaint.maxAttachments', { count: evidence.length }, locale));
        return evidence;
      }
      await next.reply(t('complaint.attachmentReceived', { count: evidence.length }, locale));
      continue;
    }

    const text = message.text?.trim() ?? '';
    if (isCancelCommand(text)) throw new FlowCancelled();
    if (menuActionFor(text)) {
      await next.reply(t('complaint.middleOfFlow', { label }, locale));
      continue;
    }
    const answer = text.toLowerCase();
    if (isKeyword('skip', answer) || isKeyword('done', answer)) {
      await clearPrompt(ctx, flow);
      return evidence;
    }

    await next.reply(
      evidence.length > 0
        ? t('complaint.sendMoreEvidence', {}, locale)
        : t('complaint.sendEvidenceOrSkip', {}, locale),
    );
  }
}

async function askEmail(
  conversation: SubmissionConversation,
  ctx: Context,
  flow: Flow,
): Promise<string | null> {
  const { locale } = flow;
  const buttons = [[flowButton('s', 'skip', locale), cancelButton(locale)]];
  await ask(ctx, flow, t('complaint.askEmail', {}, locale), buttons);

  const first = await waitForText(conversation, flow, ['s']);
  if (first.kind === 'button' || isKeyword('skip', first.text.toLowerCase())) {
    await clearPrompt(ctx, flow);
    return null;
  }
  if (first.text.includes('@')) {
    await clearPrompt(ctx, flow);
    return first.text;
  }

  await ask(ctx, flow, t('complaint.invalidEmail', {}, locale), buttons);
  const second = await waitForText(conversation, flow, ['s']);
  await clearPrompt(ctx, flow);
  if (second.kind === 'button') return null;
  return isKeyword('skip', second.text.toLowerCase()) ? null : second.text;
}

function formatSummary(label: string, data: SubmissionData, casino: CasinoChoice, locale: Locale): string {
  const casinoLine = casino.casinoId
    ? casino.casinoName
    : t('complaint.notInDatabase', { casinoName: casino.casinoName ?? '' }, locale);
  const details =
    data.description.length > SUMMARY_DETAILS_PREVIEW
      ? `${data.description.slice(0, SUMMARY_DETAILS_PREVIEW)}…`
      : data.description;

  return [
    t('complaint.summaryTitle', { label }, locale),
    '',
    t('complaint.summaryCasino', { casinoLine }, locale),
    t('complaint.summarySubject', { subject: data.subject }, locale),
    t('complaint.summaryDetails', { details }, locale),
    t('complaint.summaryAttachments', { count: data.evidenceUrls.length }, locale),
    t('complaint.summaryEmail', { email: data.contactEmail ?? t('complaint.emailNotProvided', {}, locale) }, locale),
  ].join('\n');
}

function generateCaseId(): string {
  return `BCGS-${new Date().getUTCFullYear()}-${randomInt(10000, 100000)}`;
}

function isCaseIdCollision(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  return Array.isArray(target) ? target.includes('caseId') : String(target).includes('caseId');
}

async function countRecentSubmissions(telegramUserId: string): Promise<number | null> {
  try {
    return await countRecentComplaintsByUser(telegramUserId, WINDOW_HOURS);
  } catch {
    console.warn('Could not check complaint submission limit.');
    return null;
  }
}

function getSenderDisplay(ctx: Context): string | null {
  if (ctx.from?.username) return `@${ctx.from.username}`;
  const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ');
  return name || null;
}

function truncateSubject(subject: string): string {
  if (subject.length <= ADMIN_SUBJECT_PREVIEW) return subject;
  return `${subject.slice(0, ADMIN_SUBJECT_PREVIEW - 3).trimEnd()}...`;
}

type SaveSubmissionResult = { caseId: string } | { limitReached: true };

export async function saveSubmission(data: SubmissionData): Promise<SaveSubmissionResult> {
  for (let attempt = 1; ; attempt++) {
    const caseId = generateCaseId();
    const recentCount = await countRecentSubmissions(data.telegramUserId);
    if (recentCount !== null && recentCount >= MAX_SUBMISSIONS_PER_WINDOW) {
      return { limitReached: true };
    }

    try {
      await prisma.complaint.create({
        data: { ...data, caseId, source: 'telegram', status: data.type === 'complaint' ? 'submitted' : 'received' },
        select: { caseId: true },
      });
      return { caseId };
    } catch (error) {
      if (attempt < MAX_CASE_ID_ATTEMPTS && isCaseIdCollision(error)) continue;
      throw error;
    }
  }
}

async function runSubmission(
  conversation: SubmissionConversation,
  ctx: Context,
  flow: Flow,
  type: ReportType,
  slug: string | null,
): Promise<void> {
  const { label, locale } = flow;
  const telegramUserId = String(ctx.from?.id ?? '');
  const recentCount = await conversation.external(() => countRecentSubmissions(telegramUserId));
  if (recentCount !== null && recentCount >= MAX_SUBMISSIONS_PER_WINDOW) {
    await ctx.reply(t('complaint.submissionLimit', { max: MAX_SUBMISSIONS_PER_WINDOW, hours: WINDOW_HOURS }, locale));
    return;
  }

  const preselected = slug ? await conversation.external(() => findPreselectedCasino(slug, locale)) : null;
  if (preselected) {
    await ctx.reply(t('complaint.startWithCasino', { label, casinoName: preselected.casinoName }, locale));
  } else {
    await ctx.reply(t('complaint.start', { label }, locale));
  }

  const casino = preselected ?? (await askCasino(conversation, ctx, flow));
  const subject = await askSubject(conversation, ctx, flow);
  const description = await askForText(conversation, ctx, flow, t('complaint.describeIncident', {}, locale));
  const evidenceUrls = await askEvidence(conversation, ctx, flow);
  const contactEmail = await askEmail(conversation, ctx, flow);

  const data: SubmissionData = {
    type,
    casinoId: casino.casinoId,
    casinoName: casino.casinoId ? null : casino.casinoName,
    telegramUserId,
    contactName: getSenderDisplay(ctx),
    contactEmail,
    subject,
    description,
    evidenceUrls,
  };

  await ctx.reply(formatSummary(label, data, casino, locale));
  const confirmed = await askYesNo(
    conversation,
    ctx,
    flow,
    t('complaint.confirmSubmission', { label }, locale),
    'confirm',
  );
  if (!confirmed) throw new FlowCancelled();

  const caseId = await conversation.external(async () => {
    try {
      return await saveSubmission(data);
    } catch (error) {
      console.error('Saving submission failed.');
      return null;
    }
  });

  if (!caseId) {
    await ctx.reply(t('complaint.saveFailed', {}, locale));
    return;
  }

  if ('limitReached' in caseId) {
    await ctx.reply(t('complaint.submissionLimit', { max: MAX_SUBMISSIONS_PER_WINDOW, hours: WINDOW_HOURS }, locale));
    return;
  }

  await ctx.reply(t('complaint.submitted', { caseId: caseId.caseId }, locale));

  await conversation.external(async () => {
    const adminChatId = process.env.ADMIN_CHAT_ID;
    if (!adminChatId) return;

    // The admin chat always gets English, whatever language the user filed in.
    const adminLocale = DEFAULT_LOCALE;
    try {
      const notificationType = t(
        type === 'complaint' ? 'complaint.typeComplaint' : 'complaint.typeScamReport',
        {},
        adminLocale,
      );
      await ctx.api.sendMessage(
        adminChatId,
        t('complaint.adminNotification', {
          caseId: caseId.caseId,
          type: notificationType,
          casinoName: casino.adminCasinoName,
          subject: truncateSubject(data.subject),
          sender: data.contactName ?? t('complaint.unknownSender', {}, adminLocale),
        }, adminLocale),
      );
    } catch {
      console.warn('Admin complaint notification failed.');
    }
  });
}

async function submission(
  conversation: SubmissionConversation,
  ctx: Context,
  type: ReportType,
  requestedLocale: unknown,
  casinoSlug: unknown,
) {
  // Fixed when the flow starts, so replays and a mid-flow language change can't switch it.
  const locale = isLocale(requestedLocale) ? requestedLocale : getLocale(ctx);
  const slug = type === 'complaint' && typeof casinoSlug === 'string' && casinoSlug ? casinoSlug : null;
  const flow: Flow = {
    id: await conversation.external(() => randomInt(36 ** 6).toString(36)),
    userId: ctx.from?.id ?? 0,
    chatId: ctx.chat?.id ?? 0,
    label: t(LABELS[type], {}, locale),
    locale,
    prompt: null,
  };
  try {
    await runSubmission(conversation, ctx, flow, type, slug);
  } catch (error) {
    if (!(error instanceof FlowCancelled)) throw error;
    await clearPrompt(ctx, flow);
    await ctx.reply(t('complaint.cancelled', {}, locale));
  }
}

export function registerComplaintCommands(bot: Bot<BotContext>) {
  bot.use(
    conversations<BotContext, Context>({
      // Only reached on inactivity timeout; /cancel and "no" end the flow by returning normally.
      onExit: (_id, ctx) =>
        ctx.reply(t('complaint.expired', {}, getLocale(ctx))),
    }),
  );
  bot.use(
    createConversation<BotContext, Context>(submission, {
      id: CONVERSATION_ID,
      maxMillisecondsToWait: INACTIVITY_TIMEOUT_MS,
    }),
  );

  const start = (type: ReportType) => (ctx: BotContext) => startComplaintFlow(ctx, type);

  // Reached only when no flow is running in this chat (an active flow takes its own buttons first).
  bot.callbackQuery(FLOW_CALLBACK_PATTERN, (ctx) => answerEndedFlowButton(ctx, getLocale(ctx)));

  bot.command('complaint', start('complaint'));
  bot.command('report', start('scam_report'));
  bot.command('cancel', (ctx) => ctx.reply(t('complaint.nothingToCancel', {}, getLocale(ctx))));
}

/** `casinoSlug` (complaints only) preselects that casino; the flow asks for it if the slug is no longer published. */
export async function startComplaintFlow(ctx: BotContext, type: ReportType, casinoSlug?: string): Promise<void> {
  const locale = getLocale(ctx);
  if (ctx.chat?.type !== 'private') {
    const payload = type === 'complaint' ? complaintStartParameter(casinoSlug) : 'report';
    const url = `https://t.me/${ctx.me.username}?start=${payload}`;
    const keyboard = new InlineKeyboard().url(t('complaint.openPrivateChat', {}, locale), url);
    await ctx.reply(t('complaint.privacy', { label: t(LABELS[type], {}, locale) }, locale), {
      reply_markup: keyboard,
    });
    return;
  }
  await ctx.conversation.enter(CONVERSATION_ID, type, locale, casinoSlug ?? null);
}
