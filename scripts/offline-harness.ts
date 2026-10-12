// Shared offline test harness: Prisma and Telegram are both stubbed, so nothing reaches the database or Telegram.
import type { Update } from 'grammy/types';

// Set before the Prisma client loads, so even an un-stubbed query could never reach a real database.
process.env.DATABASE_URL = 'postgresql://offline:offline@127.0.0.1:9/offline';
process.env.ADMIN_CHAT_ID = '-1009999';

type Row = Record<string, unknown>;
/** `result` is what the stub answered on success (absent when the call failed). */
export type Call = { method: string; payload: any; result?: any };
export type User = { id: number; language_code?: string; first_name?: string; last_name?: string; username?: string };

const failures: string[] = [];
export function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    console.log(`  ❌ ${name}${detail === undefined ? '' : `\n     ${JSON.stringify(detail)}`}`);
    failures.push(name);
  }
}
export function finish(): never {
  console.log(`\n${failures.length === 0 ? 'ALL PASSED' : `${failures.length} FAILED:\n - ${failures.join('\n - ')}`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

// ---------- Fixtures ----------
const casinos = [
  {
    id: 'c-stake', slug: 'stake', overallRating: 4.6, status: 'published',
    // No Thai translation: Thai users must see the English name.
    translations: [{ locale: 'en', name: 'Stake' }, { locale: 'zh', name: 'Stake 娱乐场' }],
    licenses: [{
      licenseNumber: 'OGL/2024/001',
      license: { translations: [{ locale: 'en', name: 'Curaçao' }, { locale: 'zh', name: '库拉索' }] },
    }],
  },
  {
    id: 'c-roobet', slug: 'roobet', overallRating: 4.2, status: 'published',
    // Empty Chinese name: Chinese users must see the English name.
    translations: [{ locale: 'en', name: 'Roobet' }, { locale: 'zh', name: '' }, { locale: 'th', name: 'รูเบท' }],
    licenses: [],
  },
  // Ten lower-rated casinos so rankings run to three pages (5 + 5 + 2), and "casino" matches several.
  ...['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet'].map((word, index) => ({
    id: `c-${word.toLowerCase()}`,
    // The last one has a long slug, to check callback data stays under 64 bytes.
    slug: word === 'Juliet' ? 'the-extremely-long-casino-slug-example-2026' : `${word.toLowerCase()}-casino`,
    overallRating: Math.round((4.1 - index * 0.1) * 10) / 10,
    status: 'published',
    translations: [
      { locale: 'en', name: `${word} Casino` },
      ...(word === 'Alpha' ? [{ locale: 'zh', name: '阿尔法娱乐场' }, { locale: 'th', name: 'อัลฟ่าคาสิโน' }] : []),
    ],
    licenses: [] as { licenseNumber: string; license: { translations: { locale: string; name: string }[] } }[],
  })),
  // Unpublished: must never be found, listed or preselected.
  {
    id: 'c-draft', slug: 'draft-casino', overallRating: 1.0, status: 'draft',
    translations: [{ locale: 'en', name: 'Draft Casino' }],
    licenses: [],
  },
];
const casinoTranslations = [
  { casinoId: 'c-stake', locale: 'en', reviewBody: 'English editorial review of Stake.' },
  { casinoId: 'c-stake', locale: 'zh', reviewBody: '   ' },
  { casinoId: 'c-stake', locale: 'th', reviewBody: 'รีวิวภาษาไทยของ Stake' },
  // Longer than the 500-character excerpt.
  { casinoId: 'c-delta', locale: 'en', reviewBody: 'Delta Casino pays out quickly and support answers fast. '.repeat(40).trim() },
];
// Very long author names, so the review message would pass Telegram's 4096-character limit.
const userReviews: Record<string, { rating: number; body: string; createdAt: Date; user: { displayName: string } }[]> = {
  'c-charlie': [1, 2, 3].map((n) => ({
    rating: 4, body: `Review ${n}. ${'Solid games and fair bonuses. '.repeat(10)}`, createdAt: new Date(2026, 0, n),
    user: { displayName: `Reviewer${n} ${'with a very long display name '.repeat(50)}`.trim() },
  })),
};
const category = {
  id: 'cat-crypto', slug: 'crypto', status: 'published',
  translations: [{ locale: 'en', name: 'Crypto Casinos' }, { locale: 'zh', name: '加密货币娱乐场' }],
};

// ---------- Prisma stub ----------
export const settings = new Map<string, string>();
/** SiteSetting rows, e.g. telegram_channel_url / discord_channel_url. */
export const siteSettings = new Map<string, string>();
export const db = { findUnique: 0, siteSettingQueries: 0, upserts: [] as Row[], complaints: [] as Row[] };

function localesFrom(select: any): string[] | null {
  return select?.translations?.where?.locale?.in ?? null;
}
function filterTranslations<T extends { locale: string }>(rows: T[], locales: string[] | null): T[] {
  return locales ? rows.filter((row) => locales.includes(row.locale)) : rows;
}
function shapeCasino(casino: (typeof casinos)[number], select: any): Row {
  const out: Row = {};
  if (select.id) out.id = casino.id;
  if (select.slug) out.slug = casino.slug;
  if (select.overallRating) out.overallRating = casino.overallRating;
  if (select.translations) out.translations = filterTranslations(casino.translations, localesFrom(select));
  if (select.licenses) {
    const licenseSelect = select.licenses.select.license.select;
    out.licenses = casino.licenses.map((l) => ({
      licenseNumber: l.licenseNumber,
      license: { translations: filterTranslations(l.license.translations, localesFrom(licenseSelect)) },
    }));
  }
  return out;
}
const byRating = casinos.filter((casino) => casino.status === 'published').sort((a, b) => b.overallRating - a.overallRating);

const prismaStub: Record<string, Row> = {
  telegramUserSetting: {
    findUnique: async ({ where }: any) => {
      db.findUnique += 1;
      const language = settings.get(where.telegramUserId);
      return language ? { language } : null;
    },
    findMany: async ({ take, cursor }: any) => {
      const rows = [...settings].sort(([a], [b]) => a.localeCompare(b)).map(([telegramUserId, language]) => ({ telegramUserId, language }));
      const start = cursor ? rows.findIndex((row) => row.telegramUserId === cursor.telegramUserId) + 1 : 0;
      return rows.slice(start, start + take);
    },
    upsert: async (args: any) => {
      db.upserts.push(args);
      settings.set(args.where.telegramUserId, args.create.language);
      return { telegramUserId: args.where.telegramUserId };
    },
  },
  casino: {
    findMany: async ({ select }: any) => byRating.map((casino) => shapeCasino(casino, select)),
  },
  casinoCategory: {
    findMany: async ({ where, select }: any) =>
      where.categoryId === category.id ? byRating.map((casino) => ({ casino: shapeCasino(casino, select.casino.select) })) : [],
  },
  category: {
    findFirst: async ({ where, select }: any) => {
      const input = String(where.OR[0].slug.equals).toLowerCase();
      const nameLocale = where.OR[1].translations.some.locale;
      const matches = category.slug === input ||
        category.translations.some((row) => row.locale === nameLocale && row.name.toLowerCase() === input);
      return matches
        ? { id: category.id, slug: category.slug, translations: filterTranslations(category.translations, localesFrom(select)) }
        : null;
    },
  },
  casinoTranslation: {
    findMany: async ({ where }: any) =>
      casinoTranslations.filter((row) => row.casinoId === where.casinoId && where.locale.in.includes(row.locale)),
  },
  userReview: {
    aggregate: async ({ where }: any) => {
      const rows = userReviews[where.casinoId] ?? [];
      return { _avg: { rating: rows.length ? 4 : null }, _count: rows.length };
    },
    findMany: async ({ where }: any) => userReviews[where.casinoId] ?? [],
  },
  complaint: {
    count: async () => 0,
    create: async ({ data }: any) => {
      db.complaints.push(data);
      return { caseId: data.caseId };
    },
  },
  siteSetting: {
    findMany: async ({ where }: any) => {
      db.siteSettingQueries += 1;
      return [...siteSettings].filter(([key]) => where.key.in.includes(key)).map(([key, value]) => ({ key, value }));
    },
  },
};

// ---------- Telegram stub ----------
export const calls: Call[] = [];
/** Telegram methods that answer with a 400 error, e.g. to simulate a rejected media URL. */
export const failingMethods = new Set<string>();
/** Message texts that answer with the same 400 error, to fail one message without failing every sendMessage. */
export const failingTexts = new Set<string>();
/** Media (URL or file_id) that answer with the same 400 error, e.g. to simulate a refused banner. */
export const failingMedia = new Set<string>();
/** Telegram methods that answer "message is not modified". */
export const notModifiedMethods = new Set<string>();
let messageId = 5000;
let fileIdCounter = 1;
const MEDIA_FIELD: Record<string, 'photo' | 'animation' | 'video'> = { sendPhoto: 'photo', sendAnimation: 'animation', sendVideo: 'video' };
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  const method = String(url).split('/').pop() ?? '';
  const payload = init?.body ? JSON.parse(String(init.body)) : {};
  const call: Call = { method, payload };
  calls.push(call);
  const field = MEDIA_FIELD[method];
  if (failingMethods.has(method) || (typeof payload.text === 'string' && failingTexts.has(payload.text)) ||
    (field && failingMedia.has(payload[field]))) {
    return new Response(JSON.stringify({
      ok: false, error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified',
    }));
  }
  if (notModifiedMethods.has(method)) {
    return new Response(JSON.stringify({
      ok: false, error_code: 400,
      description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
    }));
  }
  const returnsTrue = ['answerCallbackQuery', 'setMyCommands', 'deleteMyCommands', 'setChatMenuButton'].includes(method);
  const media = field && {
    photo: { photo: [{ file_id: `thumb-${fileIdCounter}`, file_unique_id: 'u', width: 90, height: 90 }, { file_id: `fid-photo-${fileIdCounter++}`, file_unique_id: 'u', width: 800, height: 400 }] },
    animation: { animation: { file_id: `fid-animation-${fileIdCounter++}`, file_unique_id: 'u', width: 1, height: 1, duration: 1 } },
    video: { video: { file_id: `fid-video-${fileIdCounter++}`, file_unique_id: 'u', width: 1, height: 1, duration: 1 } },
  }[field];
  call.result = returnsTrue
    ? true
    : {
      message_id: messageId++, date: 0, chat: { id: payload.chat_id, type: 'private' },
      ...(media ? { ...media, caption: payload.caption } : { text: payload.text }),
    };
  return new Response(JSON.stringify({ ok: true, result: call.result }));
}) as typeof fetch;

let updateId = 1;

function fromOf(user: User) {
  return {
    id: user.id, is_bot: false, first_name: user.first_name ?? 'Tester',
    ...(user.last_name ? { last_name: user.last_name } : {}),
    ...(user.username ? { username: user.username } : {}),
    ...(user.language_code ? { language_code: user.language_code } : {}),
  };
}
function chatOf(user: User, chatType: string) {
  return chatType === 'private'
    ? { id: user.id, type: 'private', first_name: 'Tester' }
    : { id: -100555, type: chatType, title: 'Group' };
}
export function textUpdate(user: User, text: string, chatType = 'private'): Update {
  const command = text.match(/^\/\S+/);
  return {
    update_id: updateId++,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000),
      chat: chatOf(user, chatType), from: fromOf(user), text,
      ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command[0].length }] } : {}),
    },
  } as unknown as Update;
}
type TapOptions = { chatType?: string; replyToText?: string; messageId?: number; media?: 'photo' | 'animation' | 'video' };

function messageBody(media: TapOptions['media']) {
  const file = { file_id: 'fid-on-screen', file_unique_id: 'u', width: 1, height: 1, duration: 1 };
  if (media === 'photo') return { photo: [file], caption: 'bot caption' };
  if (media === 'animation') return { animation: file, document: file, caption: 'bot caption' };
  if (media === 'video') return { video: file, caption: 'bot caption' };
  return { text: 'bot message' };
}

/** A button tap on a bot message (text, or `media` with a caption); `replyToText` is the user message it replied to. */
export function tapUpdate(user: User, data: string, options: TapOptions = {}): Update {
  const chat = chatOf(user, options.chatType ?? 'private');
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`, chat_instance: 'ci', data, from: fromOf(user),
      message: {
        message_id: options.messageId ?? 4242, date: 0, chat, ...messageBody(options.media),
        ...(options.replyToText
          ? { reply_to_message: { message_id: 4100, date: 0, chat, from: fromOf(user), text: options.replyToText } }
          : {}),
      },
    },
  } as unknown as Update;
}

let clockOffset = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + clockOffset;
export function advanceMinutes(minutes: number): void {
  clockOffset += minutes * 60 * 1000;
}

/** Texts sent to the user (admin-chat messages excluded). */
export function texts(from = 0): string[] {
  return calls.slice(from)
    .filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && String(c.payload.chat_id) !== process.env.ADMIN_CHAT_ID)
    .map((c) => c.payload.text as string);
}
/** The last inline keyboard sent since `from`. */
export function lastKeyboard(from = 0): any[] | undefined {
  return calls.slice(from).reverse().find((c) => c.payload.reply_markup?.inline_keyboard)?.payload.reply_markup.inline_keyboard;
}
/** Every reply (bottom) keyboard markup sent since `from`. */
export function replyKeyboards(from = 0): any[] {
  return calls.slice(from).map((c) => c.payload.reply_markup).filter((markup) => markup?.keyboard);
}

/** Installs the stubs and returns a bot wired exactly like src/bot.ts. */
export async function createOfflineBot() {
  const { prisma } = await import('../src/prisma');
  for (const [name, impl] of Object.entries(prismaStub)) {
    Object.defineProperty(prisma, name, { value: impl, configurable: true });
  }
  for (const name of ['$connect', '$queryRaw', '$executeRaw', '$transaction']) {
    Object.defineProperty(prisma, name, { value: () => { throw new Error(`offline test: ${name} is not allowed`); }, configurable: true });
  }
  if ((prisma as any).casino.findMany !== prismaStub.casino.findMany) throw new Error('Prisma stub was not installed');

  const { Bot } = await import('grammy');
  const { registerHandlers } = await import('../src/app');
  const { resolveLocale } = await import('../src/middleware/locale');
  const { rateLimit } = await import('../src/middleware/ratelimit');

  const bot = new Bot<any>('000000:OFFLINE', {
    botInfo: {
      id: 1, is_bot: true, first_name: 'Offline', username: 'offline_bot', can_join_groups: true,
      can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false,
    } as never,
    client: { fetch: fakeFetch },
  });
  bot.use(resolveLocale);
  bot.use(rateLimit);
  registerHandlers(bot);

  const send = async (update: Update) => {
    const start = calls.length;
    await bot.handleUpdate(update);
    return start;
  };
  return { bot, send };
}
