import { GrammyError, HttpError } from 'grammy';
import { DEFAULT_LOCALE, isLocale } from '../i18n';
import { buildCaseNotificationText } from './message';
import type { ClaimedNotification, OutboxStore } from './outbox';
import { realClock, SendRateLimiter, type Clock } from './rate-limiter';

export const POLL_INTERVAL_MS = 5000;
export const CLAIM_BATCH_SIZE = 20;
export const MAX_ATTEMPTS = 6;
/** Delay before attempt 2, 3, 4, 5 and 6 after a network or Telegram 5xx failure. */
export const RETRY_DELAYS_SECONDS = [30, 120, 600, 1800, 7200];
const DEFAULT_RETRY_AFTER_SECONDS = 30;
const LOG_REPEAT_MS = 60_000;

export type SendMessageApi = {
  sendMessage(
    chatId: string,
    text: string,
    other: { link_preview_options: { is_disabled: true } },
  ): Promise<{ message_id: number }>;
};

type Outcome =
  | { kind: 'sent'; messageId: string }
  | { kind: 'permanent'; code: string }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'retry'; code: string };

/** Maps a send error to what happens to the row. Codes are short and fixed; raw error text is never stored. */
export function classifySendError(error: unknown): Exclude<Outcome, { kind: 'sent' }> {
  if (error instanceof GrammyError) {
    const description = error.description.toLowerCase();
    if (error.error_code === 429) {
      const retryAfter = error.parameters?.retry_after;
      return {
        kind: 'rate_limited',
        retryAfterSeconds: typeof retryAfter === 'number' && retryAfter > 0 ? retryAfter : DEFAULT_RETRY_AFTER_SECONDS,
      };
    }
    if (error.error_code === 403) {
      if (description.includes('blocked')) return { kind: 'permanent', code: 'blocked' };
      if (description.includes('deactivated')) return { kind: 'permanent', code: 'deactivated' };
      return { kind: 'permanent', code: 'forbidden' };
    }
    if (error.error_code === 400) {
      if (description.includes('chat not found')) return { kind: 'permanent', code: 'chat_not_found' };
      return { kind: 'permanent', code: 'bad_request' };
    }
    if (error.error_code >= 500) return { kind: 'retry', code: 'telegram_5xx' };
    return { kind: 'retry', code: 'telegram_error' };
  }
  if (error instanceof HttpError) return { kind: 'retry', code: 'network' };
  return { kind: 'retry', code: 'unknown' };
}

export type CaseNotificationWorker = {
  /** One full pass: recover expired leases, claim due rows, send them. Never throws. */
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
};

export function createCaseNotificationWorker(options: {
  store: OutboxStore;
  api: SendMessageApi;
  clock?: Clock;
  limiter?: SendRateLimiter;
  log?: Pick<Console, 'warn' | 'error'>;
}): CaseNotificationWorker {
  const { store, api } = options;
  const clock = options.clock ?? realClock;
  const limiter = options.limiter ?? new SendRateLimiter(clock);
  const log = options.log ?? console;

  const lastLogged = new Map<string, number>();
  /** The same line at most once a minute, so a missing table doesn't flood the log every 5 seconds. */
  function logOnce(level: 'warn' | 'error', line: string): void {
    const now = clock.now();
    const previous = lastLogged.get(line);
    if (previous !== undefined && now - previous < LOG_REPEAT_MS) return;
    lastLogged.set(line, now);
    log[level](line);
  }

  function databaseErrorCode(error: unknown): string {
    const code = (error as { code?: unknown })?.code;
    return typeof code === 'string' && /^[A-Z0-9_]{1,12}$/.test(code) ? code : 'unknown';
  }

  async function send(row: ClaimedNotification): Promise<Outcome> {
    if (row.attempts > MAX_ATTEMPTS) return { kind: 'permanent', code: 'max_attempts' };
    const saved = await store.readLanguage(row.telegramUserId);
    const locale = isLocale(saved) ? saved : DEFAULT_LOCALE;
    const text = buildCaseNotificationText(row, locale);
    await limiter.acquire(row.telegramUserId);
    try {
      const message = await api.sendMessage(row.telegramUserId, text, { link_preview_options: { is_disabled: true } });
      return { kind: 'sent', messageId: String(message.message_id) };
    } catch (error) {
      return classifySendError(error);
    }
  }

  async function settle(row: ClaimedNotification, outcome: Outcome): Promise<void> {
    switch (outcome.kind) {
      case 'sent':
        await store.markSent(row.id, outcome.messageId);
        return;
      case 'permanent':
        await store.markPermanentFailure(row.id, outcome.code);
        return;
      case 'rate_limited':
        await store.scheduleRetry(row.id, outcome.retryAfterSeconds, 'rate_limited', true);
        return;
      case 'retry':
        if (row.attempts >= MAX_ATTEMPTS) {
          await store.markPermanentFailure(row.id, 'max_attempts');
        } else {
          const delay = RETRY_DELAYS_SECONDS[Math.min(row.attempts, RETRY_DELAYS_SECONDS.length) - 1];
          await store.scheduleRetry(row.id, delay, outcome.code, false);
        }
    }
  }

  async function tick(): Promise<void> {
    try {
      const recovered = await store.recoverExpiredLeases();
      if (recovered > 0) log.warn(`Case notifications: ${recovered} expired lease(s) returned to pending.`);

      const rows = await store.claim(CLAIM_BATCH_SIZE);
      const counts: Record<Outcome['kind'], number> = { sent: 0, permanent: 0, rate_limited: 0, retry: 0 };
      for (const row of rows) {
        try {
          const outcome = await send(row);
          await settle(row, outcome);
          counts[outcome.kind] += 1;
        } catch (error) {
          // The row keeps its lease and is recovered after it expires.
          logOnce('error', `Case notifications: could not process a row (${databaseErrorCode(error)}).`);
        }
      }
      if (counts.permanent + counts.rate_limited + counts.retry > 0) {
        log.warn(
          `Case notifications: ${counts.sent} sent, ${counts.retry} to retry, ${counts.rate_limited} rate-limited, ${counts.permanent} failed permanently.`,
        );
      }
    } catch (error) {
      logOnce('error', `Case notifications: database error (${databaseErrorCode(error)}); will retry.`);
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let stopped = true;

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      running = tick().finally(() => {
        running = null;
        schedule();
      });
    }, POLL_INTERVAL_MS);
  }

  return {
    tick,
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}

/** NOTIFICATIONS_ENABLED: on unless set to false, 0, no or off. */
export function notificationsEnabled(value = process.env.NOTIFICATIONS_ENABLED): boolean {
  return !/^(false|0|no|off)$/i.test(value?.trim() ?? '');
}
