import { prisma } from '../prisma';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '../i18n';

const CACHE_TTL_MS = 5 * 60 * 1000;

export const RANKINGS_INTRO_MAX = 300;

const MEDIA_TYPES = ['photo', 'animation', 'video'] as const;
export type RankingsMediaType = (typeof MEDIA_TYPES)[number];

/** The admin-set banner above the rankings, as stored in SiteSetting `telegram_rankings_<locale>` (JSON). */
export type RankingsBanner = {
  introText: string;
  media: { url: string; type: RankingsMediaType };
};

function bannerKey(locale: Locale): string {
  return `telegram_rankings_${locale}`;
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

/** Parses a stored value; null means "not set" (empty, not JSON, wrong shape, intro too long, or no usable media). */
export function parseRankingsBanner(stored: string | undefined): RankingsBanner | null {
  if (!stored?.trim()) return null;
  let json: unknown;
  try {
    json = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const raw = json as Record<string, unknown>;

  if (raw.introText !== undefined && raw.introText !== null && typeof raw.introText !== 'string') return null;
  const introText = typeof raw.introText === 'string' ? raw.introText.trim() : '';
  if (introText.length > RANKINGS_INTRO_MAX) return null;

  const url = httpsUrl(raw.mediaUrl);
  const type = MEDIA_TYPES.find((mediaType) => mediaType === raw.mediaType);
  if (!url || !type) return null;
  return { introText, media: { url, type } };
}

type CacheEntry = { loadedAt: number; byLocale: Map<Locale, RankingsBanner> };
let cache: CacheEntry | null = null;
let pending: Promise<CacheEntry> | null = null;

async function loadBanners(): Promise<CacheEntry> {
  const rows = await prisma.siteSetting.findMany({
    where: { key: { in: LOCALES.map(bannerKey) } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const byLocale = new Map<Locale, RankingsBanner>();
  for (const locale of LOCALES) {
    const banner = parseRankingsBanner(byKey.get(bannerKey(locale)));
    if (banner) byLocale.set(locale, banner);
  }
  return { loadedAt: Date.now(), byLocale };
}

/** The banner for `locale`, else the English one, else null (text rankings). One query per 5 minutes. */
export async function getRankingsBanner(locale: Locale): Promise<RankingsBanner | null> {
  if (!cache || Date.now() - cache.loadedAt >= CACHE_TTL_MS) {
    pending ??= loadBanners()
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
