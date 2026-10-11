import { prisma } from '../prisma';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '../i18n';

const CACHE_TTL_MS = 5 * 60 * 1000;

/** Telegram limits: message text 4096, media caption 1024. */
export const WELCOME_TEXT_MAX = 4096;
export const WELCOME_CAPTION_MAX = 1024;
const BUTTON_LABEL_MAX = 30;
const MAX_BUTTONS = 3;

const MEDIA_TYPES = ['photo', 'animation', 'video'] as const;
export type WelcomeMediaType = (typeof MEDIA_TYPES)[number];

export type WelcomeButton = { label: string; url: string };

/**
 * The admin-edited welcome for one language, as stored in SiteSetting `telegram_welcome_<locale>` (JSON).
 * `text` is the welcome message; `caption` is the media message's own caption (never the text).
 */
export type Welcome = {
  text: string;
  caption: string;
  media: { url: string; type: WelcomeMediaType } | null;
  buttons: WelcomeButton[];
};

function welcomeKey(locale: Locale): string {
  return `telegram_welcome_${locale}`;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' && url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : '';
}

/**
 * Parses a stored value. Invalid fields are dropped; null means "not set"
 * (empty, not JSON, not an object, or nothing left that Telegram can send).
 */
export function parseWelcome(stored: string | undefined): Welcome | null {
  if (!stored?.trim()) return null;
  let json: unknown;
  try {
    json = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const raw = json as Record<string, unknown>;

  const text = boundedText(raw.text, WELCOME_TEXT_MAX);

  const mediaUrl = httpsUrl(raw.mediaUrl);
  const mediaType = MEDIA_TYPES.find((type) => type === raw.mediaType);
  const media = mediaUrl && mediaType ? { url: mediaUrl, type: mediaType } : null;
  // The caption belongs to the media message; without media there is nothing to put it on.
  const caption = media ? boundedText(raw.caption, WELCOME_CAPTION_MAX) : '';

  const buttons: WelcomeButton[] = [];
  for (const item of Array.isArray(raw.buttons) ? raw.buttons : []) {
    if (!item || typeof item !== 'object') continue;
    const label = boundedText((item as Record<string, unknown>).label, BUTTON_LABEL_MAX);
    const url = httpsUrl((item as Record<string, unknown>).url);
    if (label && url) buttons.push({ label, url });
  }

  // A caption or buttons alone can't be sent.
  if (!text && !media) return null;
  return { text, caption, media, buttons: buttons.slice(0, MAX_BUTTONS) };
}

type CacheEntry = { loadedAt: number; byLocale: Map<Locale, Welcome> };
let cache: CacheEntry | null = null;
let pending: Promise<CacheEntry> | null = null;

async function loadWelcomes(): Promise<CacheEntry> {
  const rows = await prisma.siteSetting.findMany({
    where: { key: { in: LOCALES.map(welcomeKey) } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const byLocale = new Map<Locale, Welcome>();
  for (const locale of LOCALES) {
    const welcome = parseWelcome(byKey.get(welcomeKey(locale)));
    if (welcome) byLocale.set(locale, welcome);
  }
  return { loadedAt: Date.now(), byLocale };
}

/** The welcome for `locale`, else the English one, else null (use the built-in welcome). One query per 5 minutes. */
export async function getWelcome(locale: Locale): Promise<Welcome | null> {
  if (!cache || Date.now() - cache.loadedAt >= CACHE_TTL_MS) {
    pending ??= loadWelcomes()
      .then((entry) => {
        cache = entry;
        return entry;
      })
      .finally(() => {
        pending = null;
      });
    try {
      await pending;
    } catch (error) {
      // Keep serving the last good copy while the database is unreachable.
      if (!cache) throw error;
    }
  }
  const byLocale = cache?.byLocale;
  return byLocale?.get(locale) ?? byLocale?.get(DEFAULT_LOCALE) ?? null;
}
