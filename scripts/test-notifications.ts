// Offline test: the case-notification worker. Prisma and Telegram are both stubbed, so nothing reaches the database or Telegram.
// Run with: node --import tsx scripts/test-notifications.ts
import { calls, check, createOfflineBot, db, finish, settings, texts, textUpdate, type User } from './offline-harness';

type Row = {
  id: string; complaintId: string; revision: number; telegramUserId: string; caseId: string; type: string; status: string;
  casinoLabel: string; userMessage: string | null; caseUpdatedAt: Date; state: string; attempts: number;
  nextAttemptAt: number; leaseExpiresAt: number | null; sentAt: number | null; telegramMessageId: string | null;
  errorCode: string | null; createdAt: number;
};

(async () => {
  const { bot, send } = await createOfflineBot();
  const { GrammyError, HttpError } = await import('grammy');
  const { buildCaseNotificationText, cleanText, TELEGRAM_TEXT_MAX } = await import('../src/notifications/message');
  const { createCaseNotificationWorker, notificationsEnabled, MAX_ATTEMPTS, RETRY_DELAYS_SECONDS } = await import('../src/notifications/worker');
  const { SendRateLimiter } = await import('../src/notifications/rate-limiter');
  const { prismaOutboxStore, LEASE_SECONDS } = await import('../src/notifications/outbox');
  const { prisma } = await import('../src/prisma');
  const en = (await import('../src/i18n/en')).default;

  // ---------- fake clock, in-memory outbox (same rules as the SQL), Telegram stub ----------
  let now = Date.UTC(2026, 9, 12, 14, 30, 0);
  const sleeps: number[] = [];
  const clock = { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } };

  const storeCalls: string[] = [];
  const languages = new Map<string, string>();
  let rows: Row[] = [];
  let claimError: unknown = null;
  let nextId = 1;
  const seed = (overrides: Partial<Row> = {}): Row => {
    const row: Row = {
      id: `ob${nextId}`, complaintId: `cmp${nextId}`, revision: 1, telegramUserId: '5550001', caseId: 'BCGS-2026-12345',
      type: 'complaint', status: 'in_review', casinoLabel: 'Example Casino', userMessage: null,
      caseUpdatedAt: new Date(Date.UTC(2026, 9, 12, 14, 30)), state: 'pending', attempts: 0, nextAttemptAt: now,
      leaseExpiresAt: null, sentAt: null, telegramMessageId: null, errorCode: null, createdAt: now + nextId, ...overrides,
    };
    nextId += 1;
    rows.push(row);
    return row;
  };
  const processing = (id: string) => rows.find((r) => r.id === id && r.state === 'processing');
  const store = {
    async recoverExpiredLeases() {
      storeCalls.push('recoverExpiredLeases');
      const expired = rows.filter((r) => r.state === 'processing' && r.leaseExpiresAt !== null && r.leaseExpiresAt < now);
      for (const r of expired) { r.state = 'pending'; r.leaseExpiresAt = null; }
      return expired.length;
    },
    async claim(limit: number) {
      storeCalls.push('claim');
      if (claimError) throw claimError;
      const due = rows
        .filter((r) => r.state === 'pending' && r.nextAttemptAt <= now)
        .filter((r) => !rows.some((e) => e.complaintId === r.complaintId && e.revision < r.revision && ['pending', 'processing'].includes(e.state)))
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, limit);
      for (const r of due) { r.state = 'processing'; r.leaseExpiresAt = now + LEASE_SECONDS * 1000; r.attempts += 1; }
      return due.map((r) => ({ ...r }));
    },
    async markSent(id: string, telegramMessageId: string) {
      storeCalls.push('markSent');
      const r = processing(id);
      if (r) Object.assign(r, { state: 'sent', sentAt: now, telegramMessageId, leaseExpiresAt: null, errorCode: null });
    },
    async markPermanentFailure(id: string, errorCode: string) {
      storeCalls.push('markPermanentFailure');
      const r = processing(id);
      if (r) Object.assign(r, { state: 'permanent_failure', errorCode, leaseExpiresAt: null });
    },
    async scheduleRetry(id: string, delaySeconds: number, errorCode: string, refundAttempt: boolean) {
      storeCalls.push('scheduleRetry');
      const r = processing(id);
      if (r) Object.assign(r, {
        state: 'pending', nextAttemptAt: now + delaySeconds * 1000, errorCode, leaseExpiresAt: null,
        attempts: refundAttempt ? Math.max(r.attempts - 1, 0) : r.attempts,
      });
    },
    async readLanguage(telegramUserId: string) {
      storeCalls.push('readLanguage');
      return languages.get(telegramUserId) ?? null;
    },
  };

  type Sent = { chatId: string; text: string; other: any; at: number; stateDuringSend?: string; leaseDuringSend?: number | null };
  const sent: Sent[] = [];
  let behaviour: (chatId: string) => unknown = () => null;
  let messageId = 900;
  const api = {
    async sendMessage(chatId: string, text: string, other: any) {
      const row = rows.find((r) => r.telegramUserId === chatId && r.state === 'processing');
      sent.push({ chatId, text, other, at: now, stateDuringSend: row?.state, leaseDuringSend: row?.leaseExpiresAt });
      const error = behaviour(chatId);
      if (error) throw error;
      return { message_id: messageId++ };
    },
  };
  const logs: string[] = [];
  const log = { warn: (line: string) => logs.push(line), error: (line: string) => logs.push(line) };
  const worker = createCaseNotificationWorker({ store, api, clock, log, limiter: new SendRateLimiter(clock) });
  const tgError = (code: number, description: string, parameters: Record<string, number> = {}) =>
    new GrammyError(`Call to 'sendMessage' failed!`, { ok: false, error_code: code, description, parameters }, 'sendMessage', {});
  const reset = () => { rows = []; sent.length = 0; storeCalls.length = 0; logs.length = 0; sleeps.length = 0; behaviour = () => null; claimError = null; now += 60_000; };

  console.log('\n== Message layout: complaint and report in en, zh, th ==');
  const updatedAt = new Date(Date.UTC(2026, 9, 12, 14, 30));
  const complaintEn = buildCaseNotificationText({ caseId: 'BCGS-2026-12345', type: 'complaint', status: 'in_review',
    casinoLabel: 'Example Casino', userMessage: 'Please send the withdrawal screenshot.', caseUpdatedAt: updatedAt }, 'en');
  check('en complaint with message: exact layout', complaintEn === [
    'BC.GS complaint update', 'Case ID: BCGS-2026-12345', 'Casino/platform: Example Casino', 'Status: Under Review',
    'Message from BC.GS: Please send the withdrawal screenshot.', 'Last updated: 12 Oct 2026, 14:30 UTC'].join('\n'), complaintEn);
  const reportEn = buildCaseNotificationText({ caseId: 'BCGS-2026-12345', type: 'scam_report', status: 'not_verified',
    casinoLabel: 'Example Casino', userMessage: null, caseUpdatedAt: updatedAt }, 'en');
  check('en report without message: report title, no message line', reportEn === [
    'BC.GS report update', 'Case ID: BCGS-2026-12345', 'Casino/platform: Example Casino', 'Status: Not Verified',
    'Last updated: 12 Oct 2026, 14:30 UTC'].join('\n'), reportEn);
  const complaintZh = buildCaseNotificationText({ caseId: 'BCGS-2026-12345', type: 'complaint', status: 'waiting_for_more_information',
    casinoLabel: 'Example Casino', userMessage: '请补充截图。', caseUpdatedAt: updatedAt }, 'zh');
  check('zh complaint with message', complaintZh === [
    'BC.GS 投诉进度更新', 'Case ID：BCGS-2026-12345', '娱乐场/平台：Example Casino', '状态：等待补充信息',
    'BC.GS 留言：请补充截图。', '最后更新：2026年10月12日 14:30 UTC'].join('\n'), complaintZh);
  const reportZh = buildCaseNotificationText({ caseId: 'BCGS-2026-12345', type: 'scam_report', status: 'verified',
    casinoLabel: 'Example Casino', userMessage: null, caseUpdatedAt: updatedAt }, 'zh');
  check('zh report without message', reportZh.startsWith('BC.GS 举报进度更新\n') && reportZh.includes('状态：已核实') && !reportZh.includes('留言'), reportZh);
  const complaintTh = buildCaseNotificationText({ caseId: 'BCGS-2026-12345', type: 'complaint', status: 'resolved',
    casinoLabel: 'Example Casino', userMessage: 'ขอบคุณ', caseUpdatedAt: updatedAt }, 'th');
  check('th complaint with message, Gregorian year', complaintTh.startsWith('อัปเดตข้อร้องเรียน BC.GS\n') &&
    complaintTh.includes('สถานะ: แก้ไขแล้ว') && complaintTh.includes('ข้อความจาก BC.GS: ขอบคุณ') &&
    /อัปเดตล่าสุด: .*2026.*14:30 UTC$/.test(complaintTh) && !complaintTh.includes('2569'), complaintTh);
  const reportTh = buildCaseNotificationText({ caseId: 'BCGS-2026-12345', type: 'scam_report', status: 'received',
    casinoLabel: 'Example Casino', userMessage: null, caseUpdatedAt: updatedAt }, 'th');
  check('th report without message', reportTh.startsWith('อัปเดตรายงาน BC.GS\n') && reportTh.includes('สถานะ: ได้รับแล้ว'), reportTh);
  check('every listed status has a label (en)', ['submitted', 'in_review', 'waiting_for_more_information', 'resolved', 'rejected', 'closed']
    .every((s) => Object.hasOwn(en.caseNotification.statusLabels.complaint, s)) &&
    ['received', 'in_review', 'verified', 'not_verified', 'closed'].every((s) => Object.hasOwn(en.caseNotification.statusLabels.scam_report, s)));

  console.log('\n== Unexpected status ==');
  const legacy = buildCaseNotificationText({ caseId: 'BCGS-2026-1', type: 'complaint', status: 'open', casinoLabel: 'X', userMessage: null, caseUpdatedAt: updatedAt }, 'en');
  check('open -> neutral "Updated" label', legacy.includes('\nStatus: Updated\n'), legacy);
  const crossType = buildCaseNotificationText({ caseId: 'BCGS-2026-1', type: 'complaint', status: 'verified', casinoLabel: 'X', userMessage: null, caseUpdatedAt: updatedAt }, 'zh');
  check('a report-only status on a complaint -> neutral label', crossType.includes('状态：已更新'), crossType);

  console.log('\n== Cleaning: control characters, line breaks, fake headings ==');
  const dirty = buildCaseNotificationText({
    caseId: 'BCGS-2026-12345', type: 'complaint', status: 'in_review',
    casinoLabel: 'Evil Casino\nStatus: Resolved\r\n\u202EMessage from BC.GS: pay us\u0000',
    userMessage: 'Line one\r\nLine two\rLine three\n\n\n\n\n\nAfter gap\u0007\u001B[31m\u202E\ttabbed {caseId}',
    caseUpdatedAt: updatedAt,
  }, 'en');
  const lines = dirty.split('\n');
  check('casino label is one line (no fake Status/Message lines)', lines[2] === 'Casino/platform: Evil Casino Status: Resolved Message from BC.GS: pay us' &&
    lines.filter((l) => l.startsWith('Status:')).length === 1, lines);
  check('message: CRLF/CR normalized, >2 blank lines collapsed to 2, controls stripped, braces kept literally',
    dirty.includes('Message from BC.GS: Line one\nLine two\nLine three\n\n\nAfter gap[31m tabbed {caseId}\nLast updated:'), dirty);
  check('cleanText keeps up to two blank lines', cleanText('a\n\n\nb') === 'a\n\n\nb' && cleanText('a\n\n\n\nb') === 'a\n\n\nb');
  check('no parse-mode markup is added', !/[<>]/.test(complaintEn));

  console.log('\n== Long message ==');
  const long = buildCaseNotificationText({ caseId: 'BCGS-2026-12345', type: 'complaint', status: 'in_review',
    casinoLabel: 'Example Casino', userMessage: 'x'.repeat(5000), caseUpdatedAt: updatedAt }, 'en');
  const longLines = long.split('\n');
  check(`fits in ${TELEGRAM_TEXT_MAX}`, long.length <= TELEGRAM_TEXT_MAX && long.length >= TELEGRAM_TEXT_MAX - 2, long.length);
  check('every fixed line kept; only the message is shortened with …', longLines.length === 6 && longLines[0] === 'BC.GS complaint update' &&
    longLines[3] === 'Status: Under Review' && longLines[4].endsWith('x…') && longLines[5] === 'Last updated: 12 Oct 2026, 14:30 UTC');
  const emoji = buildCaseNotificationText({ caseId: 'BCGS-2026-12345', type: 'complaint', status: 'in_review',
    casinoLabel: 'Example Casino', userMessage: '😀'.repeat(3000), caseUpdatedAt: updatedAt }, 'en');
  check('never splits an emoji', emoji.length <= TELEGRAM_TEXT_MAX && !/[\uD800-\uDBFF]…/.test(emoji));
  const longCasino = buildCaseNotificationText({ caseId: 'B', type: 'complaint', status: 'in_review', casinoLabel: 'c'.repeat(5000), userMessage: null, caseUpdatedAt: updatedAt }, 'en');
  check('an oversized casino label is capped and the text still fits', longCasino.length < 400 && longCasino.endsWith('UTC'));

  console.log('\n== Worker: sends in the saved language, fresh read, plain text ==');
  reset();
  languages.set('5550001', 'zh');
  seed({ type: 'scam_report', status: 'received', userMessage: '已收到' });
  await worker.tick();
  check('one message sent, in Chinese', sent.length === 1 && sent[0].text.startsWith('BC.GS 举报进度更新'), sent.map((s) => s.text));
  check('plain text: no parse_mode, link previews disabled', sent[0].other.parse_mode === undefined && sent[0].other.link_preview_options?.is_disabled === true, sent[0].other);
  check('row marked sent with the Telegram message id; lease and error cleared', rows[0].state === 'sent' && rows[0].telegramMessageId === '900' &&
    rows[0].sentAt === now && rows[0].leaseExpiresAt === null && rows[0].errorCode === null, rows[0]);
  languages.set('5550001', 'th');
  seed({ revision: 1 });
  await worker.tick();
  check('language changed since: read fresh, no cache (Thai now)', sent[1]?.text.startsWith('อัปเดตข้อร้องเรียน BC.GS'), sent[1]?.text);

  console.log('\n== Language fallback ==');
  reset();
  languages.clear();
  seed({ telegramUserId: '5550002' });
  languages.set('5550003', 'fr');
  seed({ telegramUserId: '5550003' });
  await worker.tick();
  check('no saved language -> English', sent[0]?.text.startsWith('BC.GS complaint update'));
  check('unsupported saved language -> English', sent[1]?.text.startsWith('BC.GS complaint update'));

  console.log('\n== Claim and lease ==');
  reset();
  const leased = seed();
  const claimedAt = now;
  await worker.tick();
  check('while sending, the row is processing with a 2-minute lease', sent[0]?.stateDuringSend === 'processing' &&
    sent[0]?.leaseDuringSend === claimedAt + 120_000, sent[0]);
  check('attempts counted once per claim', leased.attempts === 1);
  reset();
  seed({ nextAttemptAt: now + 10_000 });
  await worker.tick();
  check('a row not yet due is not claimed', sent.length === 0 && rows[0].state === 'pending');

  console.log('\n== Per-case ordering ==');
  reset();
  const rev1 = seed({ complaintId: 'case-A', revision: 1, status: 'in_review' });
  const rev2 = seed({ complaintId: 'case-A', revision: 2, status: 'resolved' });
  const other = seed({ complaintId: 'case-B', revision: 1, telegramUserId: '5550009' });
  await worker.tick();
  check('first pass: revision 1 and the other case, never revision 2', sent.length === 2 && rev1.state === 'sent' && other.state === 'sent' && rev2.state === 'pending');
  await worker.tick();
  check('next pass: revision 2', sent.length === 3 && rev2.state === 'sent' && sent[2].text.includes('Status: Resolved'));
  reset();
  const blockedRev1 = seed({ complaintId: 'case-C', revision: 1 });
  const waitingRev2 = seed({ complaintId: 'case-C', revision: 2 });
  behaviour = () => new HttpError('network down', new Error('ECONNRESET'));
  await worker.tick();
  behaviour = () => null;
  now += 5_000;
  await worker.tick();
  check('revision 1 waiting for its retry still blocks revision 2', blockedRev1.state === 'pending' && waitingRev2.state === 'pending' && sent.length === 1);
  now += 30_000;
  await worker.tick();
  await worker.tick();
  check('after revision 1 is sent, revision 2 goes', blockedRev1.state === 'sent' && waitingRev2.state === 'sent');

  console.log('\n== Expired lease recovery ==');
  reset();
  const stuck = seed({ state: 'processing', attempts: 1, leaseExpiresAt: now - 1 });
  const fresh = seed({ state: 'processing', attempts: 1, leaseExpiresAt: now + 60_000, telegramUserId: '5550010' });
  await worker.tick();
  check('expired lease back to pending and sent again; attempt counted', stuck.state === 'sent' && stuck.attempts === 2);
  check('a live lease is left alone', fresh.state === 'processing' && sent.length === 1);
  check('short warning logged, without ids', logs.some((l) => l === 'Case notifications: 1 expired lease(s) returned to pending.'), logs);

  console.log('\n== Telegram failures ==');
  const failure = async (error: unknown) => {
    reset();
    const row = seed();
    behaviour = () => error;
    await worker.tick();
    return row;
  };
  let row = await failure(tgError(403, 'Forbidden: bot was blocked by the user'));
  check('403 blocked -> permanent_failure "blocked"', row.state === 'permanent_failure' && row.errorCode === 'blocked' && row.leaseExpiresAt === null, row);
  row = await failure(tgError(403, 'Forbidden: user is deactivated'));
  check('403 deactivated -> "deactivated"', row.state === 'permanent_failure' && row.errorCode === 'deactivated');
  row = await failure(tgError(403, "Forbidden: bot can't initiate conversation with a user"));
  check('other 403 -> "forbidden"', row.state === 'permanent_failure' && row.errorCode === 'forbidden');
  row = await failure(tgError(400, 'Bad Request: chat not found'));
  check('400 chat not found -> "chat_not_found"', row.state === 'permanent_failure' && row.errorCode === 'chat_not_found');
  row = await failure(tgError(400, 'Bad Request: message is too long'));
  check('other 400 -> "bad_request"', row.state === 'permanent_failure' && row.errorCode === 'bad_request');
  const before429 = now + 60_000;
  row = await failure(tgError(429, 'Too Many Requests: retry after 17', { retry_after: 17 }));
  check('429 -> pending at now + retry_after, attempt refunded', row.state === 'pending' && row.nextAttemptAt === before429 + 17_000 &&
    row.attempts === 0 && row.errorCode === 'rate_limited', row);
  row = await failure(tgError(502, 'Bad Gateway'));
  check('5xx -> retry in 30s', row.state === 'pending' && row.errorCode === 'telegram_5xx' && row.nextAttemptAt === now + 30_000 && row.attempts === 1);
  check('error codes are short fixed codes, never the raw text', !rows.some((r) => (r.errorCode ?? '').includes(' ')));

  console.log('\n== Network failures: backoff, then max attempts ==');
  reset();
  const flaky = seed();
  behaviour = () => new HttpError('Network request failed', new Error('ETIMEDOUT'));
  const delays: number[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const at = now;
    await worker.tick();
    if (flaky.state === 'pending') {
      delays.push((flaky.nextAttemptAt - at) / 1000);
      now = flaky.nextAttemptAt;
    }
  }
  check('backoff 30s, 2m, 10m, 30m, 2h', JSON.stringify(delays) === JSON.stringify(RETRY_DELAYS_SECONDS), delays);
  check(`after ${MAX_ATTEMPTS} attempts -> permanent_failure "max_attempts"`, flaky.state === 'permanent_failure' &&
    flaky.errorCode === 'max_attempts' && flaky.attempts === MAX_ATTEMPTS && sent.length === MAX_ATTEMPTS, flaky);
  reset();
  const crashLoop = seed({ attempts: MAX_ATTEMPTS });
  await worker.tick();
  check('a row already past the limit (e.g. repeated crashes) is failed without sending', crashLoop.state === 'permanent_failure' &&
    crashLoop.errorCode === 'max_attempts' && sent.length === 0);

  console.log('\n== Rate limiter ==');
  reset();
  for (let i = 0; i < 3; i++) seed({ telegramUserId: '5550100' });
  for (let i = 0; i < 25; i++) seed({ telegramUserId: `66600${i}` });
  await worker.tick();
  const sameChat = sent.filter((s) => s.chatId === '5550100').map((s) => s.at);
  check('one chat: at least 1s between messages', sameChat.length === 3 && sameChat[1] - sameChat[0] >= 1000 && sameChat[2] - sameChat[1] >= 1000, sameChat);
  const gaps = sent.slice(1).map((s, i) => s.at - sent[i].at);
  check('all chats: at least 50ms between messages (about 20 per second)', gaps.every((g) => g >= 50), gaps);
  check('20 claimed per pass, the rest wait for the next pass', sent.length === 20 && rows.filter((r) => r.state === 'pending').length === 8);
  const limiter = new SendRateLimiter(clock);
  const start = now;
  for (let i = 0; i < 40; i++) await limiter.acquire(`chat${i}`);
  check('40 different chats take about 2 seconds', now - start >= 1950 && now - start <= 2050, now - start);

  console.log('\n== Database errors never crash the worker ==');
  reset();
  claimError = Object.assign(new Error('relation "CaseNotificationOutbox" does not exist'), { code: 'P2010' });
  let threw = false;
  try { await worker.tick(); await worker.tick(); } catch { threw = true; }
  check('tick resolves on a database error', !threw);
  check('logged briefly, once per minute, with the code only', logs.length === 1 && logs[0] === 'Case notifications: database error (P2010); will retry.', logs);
  claimError = null;
  seed();
  await worker.tick();
  check('the loop carries on once the database is back', sent.length === 1);
  reset();
  const realStoreWorker = createCaseNotificationWorker({ store: prismaOutboxStore(prisma), api, clock, log });
  threw = false;
  try { await realStoreWorker.tick(); } catch { threw = true; }
  check('real Prisma store against the offline stub (raw SQL refused): tick still resolves', !threw && logs.length === 1, logs);
  reset();
  seed();
  store.markSent = async () => { throw Object.assign(new Error('connection lost'), { code: 'P1001' }); };
  threw = false;
  try { await worker.tick(); } catch { threw = true; }
  check('a failed status write after sending: logged, row keeps its lease for recovery', !threw && rows[0].state === 'processing' &&
    logs.some((l) => l.includes('(P1001)')), logs);
  store.markSent = async (id: string, telegramMessageId: string) => {
    storeCalls.push('markSent');
    const r = processing(id);
    if (r) Object.assign(r, { state: 'sent', sentAt: now, telegramMessageId, leaseExpiresAt: null, errorCode: null });
  };

  console.log('\n== Start/stop and the flag ==');
  const timed = createCaseNotificationWorker({ store, api, log });
  timed.start();
  await timed.stop();
  check('start then stop returns cleanly', true);
  check('NOTIFICATIONS_ENABLED: unset or true -> on', notificationsEnabled(undefined) && notificationsEnabled('') && notificationsEnabled('true') && notificationsEnabled('1'));
  check('NOTIFICATIONS_ENABLED: false/0/no/off -> off', ['false', 'FALSE', '0', 'no', 'off', ' false '].every((v) => !notificationsEnabled(v)));

  console.log('\n== Only outbox updates; nothing private in logs ==');
  check('the worker only used outbox operations and the language read',
    [...new Set(storeCalls)].every((name) => ['recoverExpiredLeases', 'claim', 'markSent', 'markPermanentFailure', 'scheduleRetry', 'readLanguage'].includes(name)), [...new Set(storeCalls)]);
  reset();
  seed({ userMessage: 'secret staff message', caseId: 'BCGS-2026-77777' });
  behaviour = () => tgError(403, 'Forbidden: bot was blocked by the user');
  await worker.tick();
  check('logs never contain user ids, case ids or message text', logs.length > 0 && logs.every((l) => !/5550001|BCGS-2026-77777|secret staff message/.test(l)), logs);

  console.log('\n== A notification during a complaint flow does not disturb it ==');
  const flowUser: User = { id: 7300 };
  settings.set('7300', 'en');
  const upsertsBefore = db.upserts.length;
  const complaintsBefore = db.complaints.length;
  await send(textUpdate(flowUser, '/complaint'));
  rows = [];
  seed({ telegramUserId: '7300', status: 'resolved' });
  const outboundStart = calls.length;
  const harnessWorker = createCaseNotificationWorker({
    store: { ...store, readLanguage: async (id: string) => settings.get(id) ?? null },
    api: bot.api, clock, log,
  });
  await harnessWorker.tick();
  const outbound = calls.slice(outboundStart).filter((c) => c.method === 'sendMessage');
  check('sent through the bot API to the user, plain text, previews off', outbound.length === 1 && String(outbound[0].payload.chat_id) === '7300' &&
    outbound[0].payload.parse_mode === undefined && outbound[0].payload.link_preview_options?.is_disabled === true, outbound.map((c) => c.payload));
  const at = await send(textUpdate(flowUser, 'stake'));
  check('the flow still answers the casino question next', texts(at)[0] === 'Is this about Stake? yes/no', texts(at));
  check('no database writes besides outbox updates (no settings, no complaints)', db.upserts.length === upsertsBefore && db.complaints.length === complaintsBefore);
  await send(textUpdate(flowUser, '/cancel'));

  finish();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
