// Offline test: the bot saves a complaint as "submitted" and a scam report as "received", with exactly one create and no update.
// Prisma and Telegram are both stubbed, so nothing reaches the database or Telegram.
// Run with: node --import tsx scripts/test-status.ts
import { calls, check, createOfflineBot, db, finish, settings, texts, textUpdate, type User } from './offline-harness';

(async () => {
  const { send } = await createOfflineBot();
  const { prisma } = await import('../src/prisma');

  // Record every prisma.complaint method the bot calls; anything other than count/create throws.
  const stub = (prisma as any).complaint;
  const complaintCalls: string[] = [];
  Object.defineProperty(prisma, 'complaint', {
    configurable: true,
    value: new Proxy({}, {
      get: (_target, name: string) => (...args: unknown[]) => {
        complaintCalls.push(name);
        if (name === 'count' || name === 'create') return stub[name](...args);
        throw new Error(`offline test: prisma.complaint.${name} is not allowed`);
      },
    }),
  });

  const user: User = { id: 5001 };
  settings.set('5001', 'en');
  const caseIdReply = /BCGS-\d{4}-\d{5}/;
  const adminMessages = () => calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === process.env.ADMIN_CHAT_ID);

  const run = async (inputs: string[]) => {
    const rowsBefore = db.complaints.length;
    const adminBefore = adminMessages().length;
    complaintCalls.length = 0;
    let at = 0;
    for (const input of inputs) at = await send(textUpdate(user, input));
    return {
      reply: texts(at)[0] ?? '',
      saved: db.complaints.length === rowsBefore + 1 ? db.complaints.at(-1)! : null,
      rowsAdded: db.complaints.length - rowsBefore,
      writes: complaintCalls.filter((name) => name !== 'count' && !name.startsWith('find')),
      adminAdded: adminMessages().length - adminBefore,
    };
  };

  console.log('\n== Complaint is saved as submitted ==');
  let result = await run(['/complaint', 'stake', 'yes', 'Withdrawal stuck', 'Requested on Sept 1, still nothing.', 'skip', 'skip', 'yes']);
  check('user gets the Case ID reply', caseIdReply.test(result.reply), result.reply);
  check('one row saved', result.rowsAdded === 1, result.rowsAdded);
  check('type complaint, status submitted, telegram source', result.saved?.type === 'complaint' &&
    result.saved?.status === 'submitted' && result.saved?.source === 'telegram', result.saved);
  check('exactly one create and no update/upsert/delete', JSON.stringify(result.writes) === JSON.stringify(['create']), result.writes);
  check('no moderation fields written', result.saved !== null && !('moderatedById' in result.saved) && !('moderatedAt' in result.saved), result.saved);
  check('admin notification still sent once', result.adminAdded === 1, result.adminAdded);

  console.log('\n== Scam report is saved as received ==');
  result = await run(['/report', 'stake', 'yes', 'Account frozen', 'Frozen after a big win.', 'skip', 'skip', 'yes']);
  check('user gets the Case ID reply', caseIdReply.test(result.reply), result.reply);
  check('one row saved', result.rowsAdded === 1, result.rowsAdded);
  check('type scam_report, status received, telegram source', result.saved?.type === 'scam_report' &&
    result.saved?.status === 'received' && result.saved?.source === 'telegram', result.saved);
  check('exactly one create and no update/upsert/delete', JSON.stringify(result.writes) === JSON.stringify(['create']), result.writes);
  check('admin notification still sent once', result.adminAdded === 1, result.adminAdded);

  console.log('\n== Nothing saved as open ==');
  check('no saved row has status open', db.complaints.every((row) => row.status !== 'open'), db.complaints.map((row) => row.status));

  finish();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
