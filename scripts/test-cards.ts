// Offline test: short private command menu, casino card buttons (Read Review inside Telegram), the review view
// and its Back button, and Submit Complaint from a card or review. Prisma and Telegram are both stubbed.
// Run with: node --import tsx scripts/test-cards.ts
import {
  calls, check, createOfflineBot, db, finish, settings, tapUpdate, texts, textUpdate, type Call, type User,
} from './offline-harness';

(async () => {
  // Saved languages from before this version: their chats may still carry the old long per-chat list.
  settings.set('5001', 'zh');
  settings.set('5002', 'th');
  settings.set('5003', 'en');
  settings.set('not-a-number', 'en');

  const { bot, send } = await createOfflineBot();
  const en = (await import('../src/i18n/en')).default;
  const zh = (await import('../src/i18n/zh')).default;
  const th = (await import('../src/i18n/th')).default;
  const { t } = await import('../src/i18n');
  const { setBotCommands, refreshSavedChatCommands } = await import('../src/command-menu');

  const since = (from: number, method: string) => calls.slice(from).filter((c) => c.method === method);
  const commandsOf = (c: Call) => c.payload.commands.map((x: any) => x.command).join();
  const buttons = (from: number): any[][] =>
    calls.slice(from).reverse().find((c: Call) => c.payload.reply_markup?.inline_keyboard)?.payload.reply_markup.inline_keyboard ?? [];
  const shape = (rows: any[][]) => rows.map((row) => row.map((b) => b.callback_data ?? `url:${b.url}`));
  const edited = (from: number) => since(from, 'editMessageText')[0]?.payload.text as string | undefined;
  const tap = (user: User, data: string, options = {}) => send(tapUpdate(user, data, options));
  const url = (slug: string, locale = 'en') => `url:https://www.bc.gs/${locale}/casinos/${slug}`;

  console.log('\n== Command menu: startup ==');
  let at = calls.length;
  await setBotCommands(bot);
  const privateLists = since(at, 'setMyCommands').filter((c) => c.payload.scope.type === 'all_private_chats');
  const groupLists = since(at, 'setMyCommands').filter((c) => c.payload.scope.type === 'all_group_chats');
  check('private list: /menu then /start only, in en (default), zh, th', privateLists.length === 3 &&
    privateLists.every((c) => commandsOf(c) === 'menu,start'), privateLists.map(commandsOf));
  check('private descriptions localized', JSON.stringify(privateLists.map((c) => [c.payload.language_code ?? 'en', c.payload.commands[0].description, c.payload.commands[1].description]).sort()) ===
    JSON.stringify([['en', en.menu.menu, en.menu.start], ['th', th.menu.menu, th.menu.start], ['zh', zh.menu.menu, zh.menu.start]]));
  check('group list unchanged (full, no /menu) in all three languages', groupLists.length === 3 &&
    groupLists.every((c) => commandsOf(c) === 'help,search,review,rankings,links'));
  const cleared = since(at, 'deleteMyCommands');
  check('default scope cleared for every language (no stale long list)', cleared.length === 3 &&
    cleared.every((c) => c.payload.scope.type === 'default') && cleared.map((c) => c.payload.language_code ?? 'en').sort().join() === 'en,th,zh');

  at = calls.length;
  const refreshed = await refreshSavedChatCommands(bot.api, 0);
  const perChat = since(at, 'setMyCommands');
  check('startup refresh rewrites every saved chat with the short list (3 valid ids, bad id skipped)', refreshed === 3 &&
    perChat.length === 3 && perChat.every((c) => c.payload.scope.type === 'chat' && commandsOf(c) === 'menu,start'), perChat.map((c) => c.payload.scope));
  check('...each in that user\'s language', perChat.find((c) => c.payload.scope.chat_id === 5001)?.payload.commands[0].description === zh.menu.menu &&
    perChat.find((c) => c.payload.scope.chat_id === 5002)?.payload.commands[0].description === th.menu.menu);
  check('refresh only reads the database', db.upserts.length === 0);
  at = await send(textUpdate({ id: 5001 }, '/menu'));
  check('a refreshed chat is not set again on /menu', since(at, 'setMyCommands').length === 0);

  console.log('\n== Command menu: language change ==');
  const switcher: User = { id: 5010, language_code: 'en' };
  await send(textUpdate(switcher, '/start'));
  at = await tap(switcher, 'lang:th:start');
  let chatLists = since(at, 'setMyCommands');
  check('choosing Thai sets the short Thai list for this chat', chatLists.length === 1 && chatLists[0].payload.scope.chat_id === 5010 &&
    commandsOf(chatLists[0]) === 'menu,start' && chatLists[0].payload.commands[1].description === th.menu.start);
  at = await send(textUpdate(switcher, '/language'));
  at = await tap(switcher, 'lang:zh');
  chatLists = since(at, 'setMyCommands');
  check('switching to Chinese: still only /menu and /start', chatLists.length === 1 && commandsOf(chatLists[0]) === 'menu,start' &&
    chatLists[0].payload.commands[0].description === zh.menu.menu);
  check('bottom keyboard still has all 8 buttons', calls.slice(at).find((c) => c.payload.reply_markup?.keyboard)?.payload.reply_markup.keyboard.flat().length === 8);
  check('hidden commands still work when typed', texts(await send(textUpdate(switcher, '/links')))[0]?.startsWith('🔗') === true &&
    texts(await send(textUpdate(switcher, '/help')))[0] === zh.help.private);

  const user: User = { id: 5020 };
  settings.set('5020', 'en');

  console.log('\n== Card from a single /search result ==');
  at = await send(textUpdate(user, '/search stake'));
  const singleText = texts(at)[0];
  check('card: Read Review (callback) + Visit Website (BC.GS page), Submit Complaint alone',
    JSON.stringify(shape(buttons(at))) === JSON.stringify([['v:stake', url('stake')], ['cp:stake']]), shape(buttons(at)));
  at = await tap(user, 'v:stake');
  check('Read Review edits the same message into the review', since(at, 'sendMessage').length === 0 &&
    edited(at)?.startsWith('Stake\nOverall rating: 4.6/5') === true, edited(at));
  check('review view: Visit Website + Complaint side by side, Back to the card below', JSON.stringify(shape(buttons(at))) ===
    JSON.stringify([[url('stake'), 'cp:stake'], ['c:stake']]), shape(buttons(at)));
  check('review view labels: short "📝 Complaint"', JSON.stringify(buttons(at).map((r) => r.map((b) => b.text))) ===
    JSON.stringify([['🌐 Visit Website', '📝 Complaint'], ['⬅️ Back']]));
  at = await tap(user, 'c:stake');
  check('Back shows the card again (same buttons, no Back of its own)', edited(at)?.startsWith('Stake\nRating: 4.6/5') === true &&
    JSON.stringify(shape(buttons(at))) === JSON.stringify([['v:stake', url('stake')], ['cp:stake']]), [edited(at), singleText]);

  console.log('\n== Card from a /search list ==');
  await send(textUpdate(user, '/search casino'));
  at = await tap(user, 's:bravo-casino', { replyToText: '/search casino' });
  check('card has Read Review = sv:, Back = sb', JSON.stringify(shape(buttons(at))) ===
    JSON.stringify([['sv:bravo-casino', url('bravo-casino')], ['cp:bravo-casino'], ['sb']]));
  at = await tap(user, 'sv:bravo-casino', { replyToText: '/search casino' });
  check('review opened in place, Back = s:bravo-casino', edited(at)?.startsWith('Bravo Casino\nOverall rating') === true &&
    JSON.stringify(shape(buttons(at)).at(-1)) === JSON.stringify(['s:bravo-casino']));
  at = await tap(user, 's:bravo-casino', { replyToText: '/search casino' });
  check('Back -> the card', edited(at)?.startsWith('Bravo Casino\nRating') === true);
  at = await tap(user, 'sb', { replyToText: '/search casino' });
  check('Back again -> the list', edited(at)?.startsWith("Results for 'casino'") === true);

  console.log('\n== Card from rankings ==');
  await send(textUpdate(user, '/rankings'));
  at = await tap(user, 'k:2');
  check('rankings buttons open cards (kr:)', shape(buttons(at))[0][0] === 'kr:2:delta-casino');
  at = await tap(user, 'kr:2:delta-casino');
  check('card: Read Review = kv:, Back = page 2', JSON.stringify(shape(buttons(at))) ===
    JSON.stringify([['kv:2:delta-casino', url('delta-casino')], ['cp:delta-casino'], ['k:2']]));
  at = await tap(user, 'kv:2:delta-casino');
  check('review in place, Back = the rankings card', edited(at)?.startsWith('Delta Casino\nOverall rating') === true &&
    JSON.stringify(shape(buttons(at)).at(-1)) === JSON.stringify(['kr:2:delta-casino']));
  at = await tap(user, 'kr:2:delta-casino');
  check('Back -> card', edited(at)?.startsWith('Delta Casino\nRating') === true);
  at = await tap(user, 'k:2');
  check('Back again -> rankings page 2', edited(at)?.includes('6. Delta Casino') === true);

  console.log('\n== Long reviews ==');
  at = await tap(user, 'kv:2:delta-casino');
  const delta = edited(at) ?? '';
  const excerpt = delta.split('\n')[4] ?? '';
  const fullText = 'Delta Casino pays out quickly and support answers fast. '.repeat(40);
  check('long editorial review cut at a whole word (<= 500 chars), with an ellipsis', excerpt.length <= 500 && excerpt.endsWith('…') &&
    fullText.startsWith(excerpt.slice(0, -1)) && fullText[excerpt.length - 1] === ' ', excerpt.slice(-40));
  check('...and a localized line to the full page instead of the bare link',
    delta.endsWith(`\n\n${t('review.readFull', { url: 'https://www.bc.gs/en/casinos/delta-casino' }, 'en')}`), delta.slice(-120));
  at = await tap(user, 'kv:1:charlie-casino');
  const charlie = edited(at) ?? '';
  check(`review that would pass 4096 characters is cut to ${charlie.length} (<= 4096)`, charlie.length <= 4096 && charlie.length > 3000);
  check('...cleanly, ending with the full-review line', charlie.endsWith(t('review.readFull', { url: 'https://www.bc.gs/en/casinos/charlie-casino' }, 'en')) &&
    charlie.includes('…\n\nRead the full review'), charlie.slice(-200));
  check('...buttons still there (rankings review: one action row, Back to the rankings card)', JSON.stringify(shape(buttons(at))) ===
    JSON.stringify([[url('charlie-casino'), 'cp:charlie-casino'], ['kr:1:charlie-casino']]));
  at = await send(textUpdate(user, '/review stake'));
  check('short review keeps the plain link at the end', texts(at)[0]?.endsWith('\n\nhttps://www.bc.gs/en/casinos/stake') === true);

  console.log('\n== Visit Website never uses an affiliate link ==');
  const urlButtons = calls.flatMap((c) => c.payload.reply_markup?.inline_keyboard?.flat() ?? []).filter((b: any) => b.url);
  const casinoButtons = urlButtons.filter((b: any) => b.text.includes('Visit Website'));
  check(`all ${casinoButtons.length} Visit Website buttons open https://www.bc.gs/<locale>/casinos/<slug>`,
    casinoButtons.length > 0 && casinoButtons.every((b: any) => /^https:\/\/www\.bc\.gs\/(en|zh|th)\/casinos\/[^/]+$/.test(b.url)));
  check('every URL button is on bc.gs, t.me or the configured community links',
    urlButtons.every((b: any) => /^https:\/\/(www\.bc\.gs|t\.me|discord\.gg)(\/|$)/.test(b.url)), urlButtons.map((b: any) => b.url));

  console.log('\n== Submit Complaint from a card and from the review view ==');
  const finishFlow = async (who: User) => {
    const before = db.complaints.length;
    for (const answer of ['Subject', 'Details of the problem.', 'skip', 'skip', 'yes']) await send(textUpdate(who, answer));
    return db.complaints.length === before + 1 ? db.complaints.at(-1)! : null;
  };
  at = await tap(user, 'cp:delta-casino');
  check('from the rankings card: casino named, straight to subject', JSON.stringify(texts(at)) ===
    JSON.stringify([t('complaint.startWithCasino', { label: 'complaint', casinoName: 'Delta Casino' }, 'en'), en.complaint.askSubject]), texts(at));
  check('saved casinoId c-delta', (await finishFlow(user))?.casinoId === 'c-delta');
  at = await tap(user, 'v:stake');
  const reviewComplaint = buttons(at)[0][1].callback_data;
  at = await tap(user, reviewComplaint);
  check('from the review view: preselected Stake', texts(at)[0] === t('complaint.startWithCasino', { label: 'complaint', casinoName: 'Stake' }, 'en'));
  const saved = await finishFlow(user);
  check('saved casinoId c-stake, no free-text name', saved?.casinoId === 'c-stake' && saved?.casinoName === null, saved);
  at = await tap(user, 'cp');
  check('old plain cp asks which casino', texts(at)[1] === en.complaint.askCasino);
  await send(textUpdate(user, '/cancel'));
  at = await tap(user, 'cp:no-such-casino');
  check('unknown slug asks which casino', texts(at)[1] === en.complaint.askCasino);
  at = await tap(user, 'v:stake');
  check('a card button mid-complaint gets the "middle of a submission" reply',
    JSON.stringify(texts(at)) === JSON.stringify([t('complaint.middleOfFlow', { label: 'complaint' }, 'en')]));
  await send(textUpdate(user, '/cancel'));

  console.log('\n== Groups ==');
  const groupUser: User = { id: 5030, language_code: 'en' };
  at = await send(textUpdate(groupUser, '/search stake', 'supergroup'));
  check('group card: Read Review works as a callback, complaint is the deep link',
    buttons(at)[0][0].callback_data === 'v:stake' && buttons(at)[1][0].url === 'https://t.me/offline_bot?start=complaint_stake');
  at = await tap(groupUser, 'v:stake', { chatType: 'supergroup' });
  check('group review view: complaint deep link next to Visit Website, Back to card', JSON.stringify(shape(buttons(at))) ===
    JSON.stringify([[url('stake'), 'url:https://t.me/offline_bot?start=complaint_stake'], ['c:stake']]) &&
    buttons(at)[0][1].text === '📝 Complaint' && !buttons(at)[0][1].callback_data, shape(buttons(at)));
  at = await tap(groupUser, `cp:${'x'.repeat(55)}`, { chatType: 'supergroup' });
  check('slug too long for the start parameter -> plain complaint link', buttons(at)[0]?.[0]?.url === 'https://t.me/offline_bot?start=complaint');

  console.log('\n== Labels ==');
  const zhUser: User = { id: 5040 };
  settings.set('5040', 'zh');
  at = await send(textUpdate(zhUser, '/search stake'));
  check('zh card', JSON.stringify(buttons(at).map((r) => r.map((b) => b.text))) === JSON.stringify([['📖 阅读评测', '🌐 访问网站'], ['📝 提交投诉']]) &&
    buttons(at)[0][1].url === 'https://www.bc.gs/zh/casinos/stake');
  at = await tap(zhUser, 'v:stake');
  check('zh review view', JSON.stringify(buttons(at).map((r) => r.map((b) => b.text))) === JSON.stringify([['🌐 访问网站', '📝 投诉'], ['⬅️ 返回']]) &&
    JSON.stringify(shape(buttons(at))) === JSON.stringify([[url('stake', 'zh'), 'cp:stake'], ['c:stake']]), shape(buttons(at)));
  const thUser: User = { id: 5041 };
  settings.set('5041', 'th');
  at = await send(textUpdate(thUser, '/search roobet'));
  check('th card', JSON.stringify(buttons(at).map((r) => r.map((b) => b.text))) === JSON.stringify([['📖 อ่านรีวิว', '🌐 เยี่ยมชมเว็บไซต์'], ['📝 ส่งข้อร้องเรียน']]) &&
    buttons(at)[0][1].url === 'https://www.bc.gs/th/casinos/roobet');

  console.log('\n== Stale and old buttons ==');
  for (const data of ['v:gone', 'sv:gone', 'kv:1:gone', 'c:gone', 'kr:1:gone']) {
    at = await tap(user, data);
    const answers = since(at, 'answerCallbackQuery');
    check(`${data} -> "no longer available" popup only`, answers.length === 1 && answers[0].payload.text === en.buttons.unavailable &&
      !edited(at) && since(at, 'sendMessage').length === 0);
  }
  at = await tap(user, 'r:alpha-casino', { replyToText: '/review casino' });
  check('old /review list button still opens the review with Back rb', edited(at)?.startsWith('Alpha Casino\nOverall') === true &&
    JSON.stringify(shape(buttons(at)).at(-1)) === JSON.stringify(['rb']));
  const allData = calls.flatMap((c) => c.payload.reply_markup?.inline_keyboard?.flat() ?? []).map((b: any) => b.callback_data).filter(Boolean);
  check(`all ${allData.length} callback data sent are <= 64 bytes`, allData.every((d: string) => Buffer.byteLength(d) <= 64));

  finish();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
