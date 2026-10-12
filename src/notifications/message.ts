import en from '../i18n/en';
import { t, type Locale } from '../i18n';

export const TELEGRAM_TEXT_MAX = 4096;
const CASINO_LABEL_MAX = 200;
const ELLIPSIS = '…';

/** The outbox fields a notification may show. Nothing else from the database reaches the message. */
export type CaseNotificationContent = {
  caseId: string;
  type: string;
  status: string;
  casinoLabel: string;
  userMessage: string | null;
  caseUpdatedAt: Date;
};

const DATE_LOCALES: Record<Locale, string> = {
  en: 'en-GB',
  zh: 'zh-CN',
  // Gregorian calendar, so the year matches the Case ID (BCGS-2026-...).
  th: 'th-TH-u-ca-gregory',
};

/**
 * CRLF/CR become LF, tabs become spaces, other control characters (C0, DEL, C1) and bidi
 * overrides/isolates are removed, and runs of more than two blank lines collapse to two.
 */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/** One line only, so a casino name typed by the user can't add lines that look like the fixed ones. */
function cleanCasinoLabel(raw: string): string {
  const label = cleanText(raw).replace(/\s*\n\s*/g, ' ');
  return label.length > CASINO_LABEL_MAX ? truncate(label, CASINO_LABEL_MAX) : label;
}

/** Cuts to at most `max` UTF-16 units including the ellipsis, never splitting a surrogate pair. */
function truncate(text: string, max: number): string {
  let cut = text.slice(0, Math.max(0, max - ELLIPSIS.length));
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}${ELLIPSIS}`;
}

function statusLabel(type: string, status: string, locale: Locale): string {
  const labels = en.caseNotification.statusLabels;
  if ((type === 'complaint' || type === 'scam_report') && Object.hasOwn(labels[type], status)) {
    return t(`caseNotification.statusLabels.${type}.${status}` as Parameters<typeof t>[0], {}, locale);
  }
  return t('caseNotification.statusLabels.unknown', {}, locale);
}

export function formatUpdatedAt(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(DATE_LOCALES[locale], {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

/** Plain-text case update. The fixed lines are always kept; only the staff message is shortened to fit. */
export function buildCaseNotificationText(row: CaseNotificationContent, locale: Locale): string {
  const titleKey = row.type === 'scam_report' ? 'caseNotification.title.scam_report' : 'caseNotification.title.complaint';
  const head = [
    t(titleKey, {}, locale),
    t('caseNotification.caseId', { caseId: cleanText(row.caseId).replace(/\s+/g, ' ') }, locale),
    t('caseNotification.casino', { casino: cleanCasinoLabel(row.casinoLabel) }, locale),
    t('caseNotification.status', { status: statusLabel(row.type, row.status, locale) }, locale),
  ];
  const tail = t('caseNotification.lastUpdated', { time: formatUpdatedAt(row.caseUpdatedAt, locale) }, locale);

  const message = row.userMessage === null ? '' : cleanText(row.userMessage);
  if (!message) return [...head, tail].join('\n');

  const withMessage = (text: string) => [...head, t('caseNotification.message', { message: text }, locale), tail].join('\n');
  const full = withMessage(message);
  if (full.length <= TELEGRAM_TEXT_MAX) return full;

  const room = message.length - (full.length - TELEGRAM_TEXT_MAX);
  return withMessage(truncate(message, room));
}
