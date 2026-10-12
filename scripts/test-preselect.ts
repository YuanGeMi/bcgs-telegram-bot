// Offline test: Submit Complaint on a casino card starts the complaint flow with that casino preselected.
// Prisma and Telegram are both stubbed, so nothing reaches the database or Telegram.
// Run with: node --import tsx scripts/test-preselect.ts
import {
  calls, check, createOfflineBot, db, finish, settings, tapUpdate, texts, textUpdate, type User,
} from './offline-harness';

(async () => {
  const { send } = await createOfflineBot();
  const en = (await import('../src/i18n/en')).default;
  const zh = (await import('../src/i18n/zh')).default;
  const th = (await import('../src/i18n/th')).default;
  const { t } = await import('../src/i18n');
  const { complaintStartParameter, decodeStartParameter, encodeLanguage, encodeNav, decodeNav } = await import('../src/callback-data');

  const startWith = (casinoName: string, locale: 'en' | 'zh' | 'th' = 'en', label = t('complaint.typeComplaint', {}, locale)) =>
    t('complaint.startWithCasino', { label, casinoName }, locale);
  const plainStart = t('complaint.start', { label: 'complaint' }, 'en');
  const lastButtons = (from: number): any[] =>
    (calls.slice(from).reverse().find((c) => c.payload.reply_markup?.inline_keyboard)?.payload.reply_markup.inline_keyboard ?? []).flat();
  const complaintData = (from: number) => lastButtons(from).find((b) => b.text.startsWith('📝'))?.callback_data;
  const complaintUrl = (from: number) => lastButtons(from).find((b) => b.text.startsWith('📝'))?.url;

  /** Answers every step after the casino; returns what was saved and the summary shown. */
  const finishFlow = async (user: User) => {
    const before = db.complaints.length;
    let at = await send(textUpdate(user, 'Withdrawal stuck'));
    const subjectOk = texts(at)[0] === en.complaint.describeIncident;
    await send(textUpdate(user, 'Requested on Sept 1, still nothing.'));
    await send(textUpdate(user, 'skip'));
    at = await send(textUpdate(user, 'skip'));
    const summary = texts(at)[0] ?? '';
    at = await send(textUpdate(user, 'yes'));
    const submitted = /^.*BCGS-\d{4}-\d{5}/s.test(texts(at)[0] ?? '');
    return { saved: db.complaints.length === before + 1 ? db.complaints.at(-1)! : null, summary, subjectOk, submitted };
  };

  const user: User = { id: 4001 };
  settings.set('4001', 'en');

  console.log('\n== Search card: Submit Complaint preselects the casino ==');
  let at = await send(textUpdate(user, '/search stake'));
  check('card button carries the slug', complaintData(at) === 'cp:stake', complaintData(at));
  at = await send(tapUpdate(user, 'cp:stake'));
  check('tap answered', calls.slice(at).filter((c) => c.method === 'answerCallbackQuery').length === 1);
  check('first message names the casino, then straight to the subject (no casino question)',
    JSON.stringify(texts(at)) === JSON.stringify([startWith('Stake'), en.complaint.askSubject]), texts(at));
  let result = await finishFlow(user);
  check('rest of the flow unchanged', result.subjectOk && result.submitted);
  check('summary still shows the casino', result.summary.includes(t('complaint.summaryCasino', { casinoLine: 'Stake' }, 'en')), result.summary);
  check('saved with casinoId, no free-text name (same as a confirmed match)',
    result.saved?.casinoId === 'c-stake' && result.saved?.casinoName === null && result.saved?.type === 'complaint' &&
    result.saved?.source === 'telegram' && result.saved?.status === 'submitted', result.saved);

  console.log('\n== Review (from a /review list) ==');
  await send(textUpdate(user, '/review casino'));
  at = await send(tapUpdate(user, 'r:alpha-casino', { replyToText: '/review casino' }));
  check('review button carries the slug', complaintData(at) === 'cp:alpha-casino', complaintData(at));
  at = await send(tapUpdate(user, 'cp:alpha-casino'));
  check('preselected Alpha Casino', JSON.stringify(texts(at)) === JSON.stringify([startWith('Alpha Casino'), en.complaint.askSubject]), texts(at));
  result = await finishFlow(user);
  check('saved casinoId c-alpha', result.saved?.casinoId === 'c-alpha' && result.saved?.casinoName === null, result.saved);

  console.log('\n== Review opened from rankings ==');
  at = await send(tapUpdate(user, 'kr:1:roobet'));
  check('rankings review button carries the slug', complaintData(at) === 'cp:roobet', complaintData(at));
  at = await send(tapUpdate(user, 'cp:roobet'));
  check('preselected Roobet', texts(at)[0] === startWith('Roobet') && texts(at)[1] === en.complaint.askSubject, texts(at));
  result = await finishFlow(user);
  check('saved casinoId c-roobet', result.saved?.casinoId === 'c-roobet', result.saved);

  console.log('\n== Without a casino: still asks, as before ==');
  at = await send(tapUpdate(user, 'cp'));
  check('old plain cp button asks which casino', JSON.stringify(texts(at)) === JSON.stringify([plainStart, en.complaint.askCasino]), texts(at));
  await send(textUpdate(user, '/cancel'));
  at = await send(textUpdate(user, '/complaint'));
  check('/complaint asks which casino', texts(at)[1] === en.complaint.askCasino);
  await send(textUpdate(user, '/cancel'));
  at = await send(textUpdate(user, '📝 Complaint'));
  check('bottom keyboard Complaint asks which casino', texts(at)[1] === en.complaint.askCasino, texts(at));
  await send(textUpdate(user, '/cancel'));
  at = await send(textUpdate(user, '/report'));
  check('/report unchanged', JSON.stringify(texts(at)) ===
    JSON.stringify([t('complaint.start', { label: t('complaint.typeReport', {}, 'en') }, 'en'), en.complaint.askCasino]), texts(at));
  await send(textUpdate(user, '/cancel'));

  console.log('\n== Unknown or unpublished slug falls back to asking ==');
  for (const slug of ['no-such-casino', 'draft-casino']) {
    at = await send(tapUpdate(user, `cp:${slug}`));
    check(`cp:${slug} -> normal start + casino question`, JSON.stringify(texts(at)) === JSON.stringify([plainStart, en.complaint.askCasino]), texts(at));
    await send(textUpdate(user, '/cancel'));
  }
  at = await send(textUpdate(user, '/start complaint_draft-casino'));
  check('deep link to an unpublished casino also asks', texts(at)[1] === en.complaint.askCasino, texts(at));
  await send(textUpdate(user, '/cancel'));

  console.log('\n== Mid-complaint taps ==');
  await send(textUpdate(user, '/complaint'));
  at = await send(tapUpdate(user, 'cp:stake'));
  check('cp:<slug> mid-flow gets the "middle of a submission" reply, no new flow',
    JSON.stringify(texts(at)) === JSON.stringify([t('complaint.middleOfFlow', { label: 'complaint' }, 'en')]), texts(at));
  check('...and the original flow still wants the casino', texts(await send(textUpdate(user, 'stake')))[0] === t('complaint.confirmCasino', { casinoName: 'Stake' }, 'en'));
  await send(textUpdate(user, '/cancel'));

  console.log('\n== Groups: deep link with the slug ==');
  const groupUser: User = { id: 4002, language_code: 'en' };
  at = await send(textUpdate(groupUser, '/search stake', 'supergroup'));
  check('group card: link to ?start=complaint_stake, no callback', complaintUrl(at) === 'https://t.me/offline_bot?start=complaint_stake' &&
    !lastButtons(at).some((b) => b.callback_data?.startsWith('cp')), complaintUrl(at));
  at = await send(tapUpdate(groupUser, `kr:3:the-extremely-long-casino-slug-example-2026`, { chatType: 'supergroup' }));
  check('43-char slug still fits (53 chars)',
    complaintUrl(at) === 'https://t.me/offline_bot?start=complaint_the-extremely-long-casino-slug-example-2026', complaintUrl(at));
  const tooLong = 'x'.repeat(55);
  at = await send(tapUpdate(groupUser, `cp:${tooLong}`, { chatType: 'supergroup' }));
  const redirect = lastButtons(at)[0]?.url;
  check('forged cp:<slug> in a group: privacy redirect only; a slug over 54 chars -> plain complaint link',
    texts(at)[0] === t('complaint.privacy', { label: 'complaint' }, 'en') && redirect === 'https://t.me/offline_bot?start=complaint', redirect);
  check('start parameter: slug that fits', complaintStartParameter('stake') === 'complaint_stake');
  check('start parameter: exactly 64 chars allowed', complaintStartParameter('y'.repeat(54)).length === 64);
  check('start parameter: 65 chars -> plain', complaintStartParameter('y'.repeat(55)) === 'complaint');
  check('start parameter: disallowed characters -> plain', complaintStartParameter('café.casino') === 'complaint');

  console.log('\n== Private chat via the deep link ==');
  at = await send(textUpdate(user, '/start complaint_stake'));
  check('/start complaint_stake preselects Stake', JSON.stringify(texts(at)) === JSON.stringify([startWith('Stake'), en.complaint.askSubject]), texts(at));
  result = await finishFlow(user);
  check('saved casinoId c-stake', result.saved?.casinoId === 'c-stake', result.saved);
  at = await send(textUpdate(user, '/start complaint'));
  check('/start complaint still asks', texts(at)[1] === en.complaint.askCasino);
  await send(textUpdate(user, '/cancel'));
  const newUser: User = { id: 4003, language_code: 'en' };
  at = await send(textUpdate(newUser, '/start complaint_roobet'));
  const langData = lastButtons(at).map((b) => b.callback_data).join();
  check('new user: language picker keeps the slug', langData === 'lang:en:complaint:roobet,lang:zh:complaint:roobet,lang:th:complaint:roobet', langData);
  at = await send(tapUpdate(newUser, 'lang:th:complaint:roobet'));
  check('after picking Thai: preselected Roobet with its Thai name', texts(at).includes(startWith('รูเบท', 'th')) &&
    texts(at).at(-1) === th.complaint.askSubject, texts(at));
  await send(textUpdate(newUser, '/cancel'));
  at = await send(tapUpdate(newUser, 'lang:en:complaint'));
  check('old language button without a slug still asks', texts(at).at(-1) === en.complaint.askCasino, texts(at));
  await send(textUpdate(newUser, '/cancel'));
  check('language data with the longest slug fits or drops the slug',
    Buffer.byteLength(encodeLanguage('th', 'complaint', 'the-extremely-long-casino-slug-example-2026')) <= 64 &&
    encodeLanguage('th', 'complaint', 'z'.repeat(60)) === 'lang:th:complaint');

  console.log('\n== First message in Chinese and Thai ==');
  const zhUser: User = { id: 4004 };
  settings.set('4004', 'zh');
  at = await send(tapUpdate(zhUser, 'cp:stake'));
  check('zh', JSON.stringify(texts(at)) === JSON.stringify(['开始提交你关于 Stake 娱乐场 的投诉。你可以随时输入 /cancel 停止。', zh.complaint.askSubject]), texts(at));
  await send(textUpdate(zhUser, '/cancel'));
  const thUser: User = { id: 4005 };
  settings.set('4005', 'th');
  at = await send(tapUpdate(thUser, 'cp:alpha-casino'));
  check('th', JSON.stringify(texts(at)) === JSON.stringify([startWith('อัลฟ่าคาสิโน', 'th'), th.complaint.askSubject]), texts(at));
  check('th wording', texts(at)[0] === 'มาเริ่มส่งข้อร้องเรียนเกี่ยวกับ อัลฟ่าคาสิโน ของคุณกัน พิมพ์ /cancel เพื่อหยุดได้ทุกเมื่อ', texts(at)[0]);
  await send(textUpdate(thUser, '/cancel'));
  check('en wording', startWith('Stake') === "Let's file your complaint about Stake. You can type /cancel at any time to stop.");

  console.log('\n== Formats ==');
  const long = 'the-extremely-long-casino-slug-example-2026';
  check('cp:<slug> round trip', JSON.stringify(decodeNav(encodeNav({ kind: 'complaint', slug: long })!)) === JSON.stringify({ kind: 'complaint', slug: long }));
  check('plain cp still decodes', JSON.stringify(decodeNav('cp')) === JSON.stringify({ kind: 'complaint' }));
  check('slug over 61 bytes -> plain cp (button kept)', encodeNav({ kind: 'complaint', slug: 'q'.repeat(62) }) === 'cp');
  check('start parameters decode', JSON.stringify(['complaint', 'complaint_stake', 'report', 'language', 'hello', 'complaint_'].map(decodeStartParameter)) ===
    JSON.stringify([{ kind: 'complaint' }, { kind: 'complaint', slug: 'stake' }, { kind: 'report' }, { kind: 'language' }, { kind: 'none' }, { kind: 'complaint' }]));
  const allData = calls.flatMap((c) => c.payload.reply_markup?.inline_keyboard?.flat() ?? []).map((b: any) => b.callback_data).filter(Boolean);
  check(`all ${allData.length} callback data sent are <= 64 bytes`, allData.every((d: string) => Buffer.byteLength(d) <= 64));

  finish();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
