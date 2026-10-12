import type { MessageEntity } from 'grammy/types';
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

/** Text plus bold entities. Sent without a parse mode, so nothing in the text is ever read as markup. */
export type CaseNotification = { text: string; entities: MessageEntity[] };

class EntityWriter {
  text = '';
  readonly entities: MessageEntity[] = [];

  bold(part: string): void {
    const label = part.trimEnd();
    if (label) this.entities.push({ type: 'bold', offset: this.text.length, length: label.length });
    this.text += part;
  }

  plain(part: string): void {
    this.text += part;
  }

  /** Catalog text before `{name}` is bold; the value and anything after it are plain. */
  labelled(template: string, name: string, value: string): void {
    const marker = `{${name}}`;
    const at = template.indexOf(marker);
    if (at < 0) return this.bold(template);
    this.bold(template.slice(0, at));
    this.plain(value);
    this.plain(template.slice(at + marker.length));
  }
}

type CatalogKey = Parameters<typeof t>[0];

/**
 * Case update with bold title and labels. Every "BC.GS" from the catalogs sits inside a bold entity,
 * so Telegram doesn't auto-link it. The fixed lines are always kept; only the staff message is shortened to fit.
 */
export function buildCaseNotification(row: CaseNotificationContent, locale: Locale): CaseNotification {
  const text = (key: CatalogKey) => t(key, {}, locale);
  const titleKey = row.type === 'scam_report' ? 'caseNotification.title.scam_report' : 'caseNotification.title.complaint';
  const caseId = cleanText(row.caseId).replace(/\s+/g, ' ');
  const casino = cleanCasinoLabel(row.casinoLabel);
  const status = statusLabel(row.type, row.status, locale);
  const time = formatUpdatedAt(row.caseUpdatedAt, locale);

  const write = (message: string): CaseNotification => {
    const w = new EntityWriter();
    w.bold(text(titleKey));
    w.plain('\n\n');
    w.labelled(text('caseNotification.caseId'), 'caseId', caseId);
    w.plain('\n');
    w.labelled(text('caseNotification.casino'), 'casino', casino);
    w.plain('\n');
    w.labelled(text('caseNotification.status'), 'status', status);
    w.plain('\n\n');
    if (message) {
      w.bold(text('caseNotification.messageHeading'));
      w.plain('\n');
      w.plain(message);
      w.plain('\n\n');
    }
    w.labelled(text('caseNotification.lastUpdated'), 'time', time);
    return { text: w.text, entities: w.entities };
  };

  const message = row.userMessage === null ? '' : cleanText(row.userMessage);
  const full = write(message);
  if (!message || full.text.length <= TELEGRAM_TEXT_MAX) return full;
  return write(truncate(message, message.length - (full.text.length - TELEGRAM_TEXT_MAX)));
}
