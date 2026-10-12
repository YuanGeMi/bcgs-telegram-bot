// Offline test for inline buttons under /search, /review, /rankings and /links.
// Prisma and Telegram are both stubbed, so nothing reaches the database or Telegram.
// Run with: node --import tsx scripts/test-inline.ts
import {
  calls, check, createOfflineBot, finish, settings, siteSettings, tapUpdate, texts, textUpdate, type Call, type User,
} from './offline-harness';

(async () => {
  const { send } = await createOfflineBot();
  const en = (await import('../src/i18n/en')).default;
  const zh = (await import('../src/i18n/zh')).default;
  const th = (await import('../src/i18n/th')).default;
  const { t } = await import('../src/i18n');
  const { encodeNav, decodeNav, decodeFlowButton, MAX_CALLBACK_BYTES } = await import('../src/callback-data');

  const LONG = 'the-extremely-long-casino-slug-example-2026';
  /** Inline keyboard of the last message sent or edited since `from`. */
  const buttons = (from: number): any[][] =>
    calls.slice(from).reverse().find((c: Call) => c.payload.reply_markup?.inline_keyboard)?.payload.reply_markup.inline_keyboard ?? [];
  const shape = (rows: any[][]) => rows.map((row) => row.map((b) => b.callback_data ?? `url:${b.url}`));
  const rowLabels = (rows: any[][]) => rows.map((row) => row.map((b) => b.text));
  const answers = (from: number) => calls.slice(from).filter((c) => c.method === 'answerCallbackQuery');
  const edits = (from: number) => calls.slice(from).filter((c) => c.method === 'editMessageText');
  const sends = (from: number) => calls.slice(from).filter((c) => c.method === 'sendMessage');
  const badAnswers: string[] = [];
  const tap = async (user: User, data: string, options = {}) => {
    const from = await send(tapUpdate(user, data, options));
    if (answers(from).length !== 1) badAnswers.push(`${data} (${answers(from).length})`);
    return from;
  };
  const unavailableOnly = (at: number, text: string) =>
    answers(at).length === 1 && answers(at)[0].payload.text === text && edits(at).length === 0 && sends(at).length === 0;

  const english: User = { id: 3001 };
  settings.set('3001', 'en');
  const url = (slug: string, locale = 'en') => `url:https://www.bc.gs/${locale}/casinos/${slug}`;

  console.log('\n== Search: single match is a casino card ==');
  let at = await send(textUpdate(english, '/search stake'));
  check('text unchanged', texts(at)[0]?.startsWith("Results for 'stake':\n\n1. Stake\nRating: 4.6/5") ?? false, texts(at)[0]);
  check('Read Review (callback) + Visit Website (BC.GS page), then Submit Complaint',
    JSON.stringify(shape(buttons(at))) === JSON.stringify([['v:stake', url('stake')], ['cp:stake']]), shape(buttons(at)));
  check('labels with emoji', JSON.stringify(rowLabels(buttons(at))) ===
    JSON.stringify([['📖 Read Review', '🌐 Visit Website'], ['📝 Submit Complaint']]), rowLabels(buttons(at)));
  check('a single result is not sent as a reply', !sends(at)[0]?.payload.reply_parameters);

  console.log('\n== Search: several matches list casinos, tapping opens a card ==');
  at = await send(textUpdate(english, '/search casino'));
  const listText = texts(at)[0];
  const listRows = buttons(at);
  check('5 casinos, one per row, names as labels', JSON.stringify(rowLabels(listRows)) ===
    JSON.stringify([['Alpha Casino'], ['Bravo Casino'], ['Charlie Casino'], ['Delta Casino'], ['Echo Casino']]), rowLabels(listRows));
  check('callback data is s:<slug>', listRows.flat().map((b) => b.callback_data).join() ===
    's:alpha-casino,s:bravo-casino,s:charlie-casino,s:delta-casino,s:echo-casino');
  check('list replies to the user message (for Back)', sends(at)[0]?.payload.reply_parameters?.allow_sending_without_reply === true &&
    typeof sends(at)[0]?.payload.reply_parameters?.message_id === 'number');
  at = await tap(english, 's:bravo-casino', { replyToText: '/search casino' });
  check('card edited in place, answered', edits(at).length === 1 && sends(at).length === 0 && answers(at).length === 1 && !answers(at)[0].payload.text);
  check('card text', edits(at)[0]?.payload.text === `Bravo Casino\nRating: 4.0/5\nLicense: None listed\nhttps://www.bc.gs/en/casinos/bravo-casino`, edits(at)[0]?.payload.text);
  check('card buttons end with Back', JSON.stringify(shape(buttons(at))) ===
    JSON.stringify([['sv:bravo-casino', url('bravo-casino')], ['cp:bravo-casino'], ['sb']]), shape(buttons(at)));
  at = await tap(english, 'sb', { replyToText: '/search casino' });
  check('Back restores the same list in place', edits(at)[0]?.payload.text === listText &&
    JSON.stringify(buttons(at)) === JSON.stringify(listRows));
  at = await tap(english, 'sb', { replyToText: 'casino' });
  check('Back works when the list came from the 🔍 Search button (plain text query)', edits(at)[0]?.payload.text === listText);
  at = await tap(english, 'sb');
  check('Back with no replied-to message -> "no longer available"', unavailableOnly(at, en.buttons.unavailable));

  console.log('\n== Review ==');
  at = await send(textUpdate(english, '/review stake'));
  check('review: Visit Website + Complaint in one row, no Back', JSON.stringify(shape(buttons(at))) === JSON.stringify([[url('stake'), 'cp:stake']]) &&
    JSON.stringify(rowLabels(buttons(at))) === JSON.stringify([['🌐 Visit Website', '📝 Complaint']]), shape(buttons(at)));
  check('review text unchanged', texts(at)[0]?.startsWith('Stake\nOverall rating: 4.6/5') ?? false);
  at = await send(textUpdate(english, '/review casino'));
  const chooseText = texts(at)[0];
  check('several matches: casino buttons r:<slug>', chooseText?.startsWith('Multiple casinos found') &&
    buttons(at).flat().map((b) => b.callback_data).join() === 'r:alpha-casino,r:bravo-casino,r:charlie-casino,r:delta-casino,r:echo-casino');
  at = await tap(english, 'r:alpha-casino', { replyToText: '/review casino' });
  check('review opened from the list, with Back last', edits(at)[0]?.payload.text.startsWith('Alpha Casino\nOverall rating: 4.1/5') &&
    JSON.stringify(shape(buttons(at))) === JSON.stringify([[url('alpha-casino'), 'cp:alpha-casino'], ['rb']]), shape(buttons(at)));
  at = await tap(english, 'rb', { replyToText: '/review@offline_bot casino' });
  check('Back to the /review list', edits(at)[0]?.payload.text === chooseText);

  console.log('\n== Rankings: pages of 5, edited in place ==');
  at = await send(textUpdate(english, '/rankings'));
  check('page 1: title counts all 12, ranks 1-5', texts(at)[0]?.startsWith('Top 12 casinos overall:\n\n1. Stake') &&
    texts(at)[0]?.includes('5. Charlie Casino') && !texts(at)[0]?.includes('6. '), texts(at)[0]);
  check('page 1: five casino buttons + Next only', JSON.stringify(shape(buttons(at))) === JSON.stringify([
    ['kr:1:stake'], ['kr:1:roobet'], ['kr:1:alpha-casino'], ['kr:1:bravo-casino'], ['kr:1:charlie-casino'], ['k:2'],
  ]), shape(buttons(at)));
  check('casino buttons are "rank. name"', buttons(at)[0][0].text === '1. Stake' && buttons(at)[5][0].text === '▶️ Next');
  at = await tap(english, 'k:2');
  check('middle page: ranks 6-10, edited not sent', edits(at)[0]?.payload.text.includes('\n\n6. Delta Casino') &&
    edits(at)[0]?.payload.text.includes('10. Hotel Casino') && sends(at).length === 0);
  check('middle page: Previous and Next on one row', JSON.stringify(shape(buttons(at)).at(-1)) === JSON.stringify(['k:1', 'k:3']) &&
    rowLabels(buttons(at)).at(-1)?.join() === '◀️ Previous,▶️ Next');
  at = await tap(english, 'k:3');
  check('last page: ranks 11-12, Previous only', edits(at)[0]?.payload.text.includes('11. India Casino') &&
    edits(at)[0]?.payload.text.includes('12. Juliet Casino') &&
    JSON.stringify(shape(buttons(at))) === JSON.stringify([['kr:3:india-casino'], [`kr:3:${LONG}`], ['k:2']]), shape(buttons(at)));
  at = await tap(english, 'k:4');
  check('page past the end -> "no longer available"', unavailableOnly(at, en.buttons.unavailable));
  at = await tap(english, 'kr:2:echo-casino');
  check('casino from rankings opens its card with Back to that page',
    edits(at)[0]?.payload.text.startsWith('Echo Casino\nRating:') &&
    JSON.stringify(shape(buttons(at))) === JSON.stringify([['kv:2:echo-casino', url('echo-casino')], ['cp:echo-casino'], ['k:2']]), shape(buttons(at)));
  at = await tap(english, 'k:2');
  check('...and Back returns to page 2', edits(at)[0]?.payload.text.includes('6. Delta Casino') ?? false);
  at = await send(textUpdate(english, '/rankings Crypto Casinos'));
  check('category rankings carry the category slug', shape(buttons(at)).at(-1)?.join() === 'k:2:crypto' &&
    shape(buttons(at))[0][0] === 'kr:1:stake:crypto');
  at = await tap(english, 'k:3:crypto');
  check('category last page', edits(at)[0]?.payload.text.startsWith('Top 12 casinos in Crypto Casinos:\n\n11. India Casino') &&
    JSON.stringify(shape(buttons(at)).at(-1)) === JSON.stringify(['k:2:crypto']), edits(at)[0]?.payload.text);
  at = await tap(english, `kr:3:${LONG}:crypto`);
  check('long slug + category card works, Back keeps the category', edits(at)[0]?.payload.text.startsWith('Juliet Casino') &&
    JSON.stringify(shape(buttons(at)).at(-1)) === JSON.stringify(['k:3:crypto']) && shape(buttons(at))[0][0] === `kv:3:${LONG}:crypto`);
  at = await tap(english, `kv:3:${LONG}:crypto`);
  check('...its review keeps the category on Back to the card', edits(at)[0]?.payload.text.startsWith('Juliet Casino\nOverall rating') &&
    JSON.stringify(shape(buttons(at)).at(-1)) === JSON.stringify([`kr:3:${LONG}:crypto`]));
  at = await tap(english, 'k:1:no-such-category');
  check('removed category -> "no longer available"', unavailableOnly(at, en.buttons.unavailable));

  console.log('\n== Links ==');
  siteSettings.set('telegram_channel_url', 'https://t.me/bcgs_official');
  at = await send(textUpdate(english, '/links'));
  check('without Discord: Website + Community, no Discord', JSON.stringify(shape(buttons(at))) ===
    JSON.stringify([['url:https://www.bc.gs', 'url:https://t.me/bcgs_official']]), shape(buttons(at)));
  check('links text unchanged', texts(at)[0] === '🔗 BC.GS Links\n\n🌐 Website: https://www.bc.gs\n💬 Official Community: https://t.me/bcgs_official');
  siteSettings.set('discord_channel_url', 'https://discord.gg/bcgs');
  at = await send(textUpdate(english, '/links'));
  check('with Discord: Discord on its own row', JSON.stringify(shape(buttons(at))) ===
    JSON.stringify([['url:https://www.bc.gs', 'url:https://t.me/bcgs_official'], ['url:https://discord.gg/bcgs']]) &&
    rowLabels(buttons(at)).flat().join() === '🌐 Website,💬 Community,🎮 Discord', rowLabels(buttons(at)));
  siteSettings.set('telegram_channel_url', '   ');
  siteSettings.delete('discord_channel_url');
  at = await send(textUpdate(english, '/links'));
  check('empty URL setting -> button skipped', JSON.stringify(shape(buttons(at))) === JSON.stringify([['url:https://www.bc.gs']]));

  console.log('\n== Stale or unknown callback data ==');
  for (const data of ['s:no-such-casino', 'r:no-such-casino', 'kr:1:no-such-casino', 'zz:whatever', 'kr:abc', 'k:0', '']) {
    at = await tap(english, data);
    check(`"${data}" -> answered "no longer available", nothing else`, unavailableOnly(at, en.buttons.unavailable), calls.slice(at));
  }

  console.log('\n== Submit Complaint ==');
  at = await tap(english, 'cp');
  check('private: answered, starts the same flow as /complaint', answers(at).length === 1 &&
    texts(at)[0] === t('complaint.start', { label: 'complaint' }, 'en') && texts(at)[1] === en.complaint.askCasino, texts(at));
  check('no casino pre-filled (asks which casino)', texts(at)[1] === en.complaint.askCasino);
  await send(textUpdate(english, '/cancel'));

  console.log('\n== A button tapped mid-complaint ==');
  const zhUser: User = { id: 3002 };
  settings.set('3002', 'zh');
  const middle = t('complaint.middleOfFlow', { label: '投诉' }, 'zh');
  await send(textUpdate(zhUser, '/complaint'));
  at = await tap(zhUser, 'k:2');
  check('Next tapped mid-flow: answered + "in the middle" message, no edit', answers(at).length === 1 &&
    JSON.stringify(texts(at)) === JSON.stringify([middle]) && edits(at).length === 0, calls.slice(at));
  at = await tap(zhUser, 'cp');
  check('Submit Complaint mid-flow: same message, no second flow', JSON.stringify(texts(at)) === JSON.stringify([middle]) && answers(at).length === 1);
  check('flow untouched: casino question still answered', (texts(await send(textUpdate(zhUser, 'stake'))))[0] === '是关于 Stake 娱乐场 吗？是/否');
  await send(textUpdate(zhUser, '是'));
  await send(textUpdate(zhUser, '主题'));
  await send(textUpdate(zhUser, '详情'));
  at = await tap(zhUser, 's:stake', { replyToText: 'stake' });
  check('evidence step: tap answered + same message', answers(at).length === 1 && JSON.stringify(texts(at)) === JSON.stringify([middle]));
  check('evidence step continues with 跳过', texts(await send(textUpdate(zhUser, '跳过')))[0] === zh.complaint.askEmail);
  await send(textUpdate(zhUser, '/cancel'));

  console.log('\n== Groups ==');
  const groupUser: User = { id: 3003, language_code: 'en' };
  at = await send(textUpdate(groupUser, '/search stake', 'supergroup'));
  const complaintButton = buttons(at)[1]?.[0];
  check('Submit Complaint is a URL deep link, never a callback', complaintButton?.url === 'https://t.me/offline_bot?start=complaint_stake' &&
    !complaintButton?.callback_data && complaintButton?.text === '📝 Submit Complaint', complaintButton);
  at = await send(textUpdate(groupUser, '/review stake', 'supergroup'));
  check('review in group: complaint is the deep link too, beside Visit Website', JSON.stringify(shape(buttons(at))) ===
    JSON.stringify([[url('stake'), 'url:https://t.me/offline_bot?start=complaint_stake']]) && !buttons(at)[0]?.[1]?.callback_data, shape(buttons(at)));
  at = await tap(groupUser, 's:stake', { chatType: 'supergroup', replyToText: '/search st' });
  check('card opened in a group: deep link button', buttons(at)[1]?.[0]?.url === 'https://t.me/offline_bot?start=complaint_stake' &&
    edits(at).length === 1);
  at = await tap(groupUser, 'k:2', { chatType: 'supergroup' });
  check('rankings paging works in a group', edits(at)[0]?.payload.text.includes('6. Delta Casino') ?? false);
  at = await tap(groupUser, 'cp', { chatType: 'supergroup' });
  check('a forged cp in a group never starts the flow (privacy redirect only)',
    texts(at)[0] === t('complaint.privacy', { label: 'complaint' }, 'en') && !texts(at).includes(en.complaint.askCasino), texts(at));
  const spammer: User = { id: 3004, language_code: 'en' };
  let limited: Call[] = [];
  for (let i = 0; i < 6; i++) {
    at = await tap(spammer, 'k:2', { chatType: 'supergroup' });
    limited = answers(at);
  }
  check('group rate limit applies to taps; the 6th is answered with "slow down"',
    limited.length === 1 && limited[0].payload.text === en.rateLimit.slowDown && edits(at).length === 0);

  console.log('\n== Chinese and Thai ==');
  const thUser: User = { id: 3005 };
  settings.set('3005', 'th');
  at = await send(textUpdate(zhUser, '/search stake'));
  check('zh card labels and Chinese site URL', JSON.stringify(rowLabels(buttons(at))) ===
    JSON.stringify([['📖 阅读评测', '🌐 访问网站'], ['📝 提交投诉']]) && buttons(at)[0][1].url === 'https://www.bc.gs/zh/casinos/stake');
  at = await send(textUpdate(zhUser, '/rankings'));
  check('zh rankings: localized names on buttons, Chinese Next', buttons(at)[2][0].text === '3. 阿尔法娱乐场' && buttons(at)[5][0].text === '▶️ 下一页');
  at = await tap(thUser, 'k:2');
  check('th pager labels', rowLabels(buttons(at)).at(-1)?.join() === '◀️ ก่อนหน้า,▶️ ถัดไป');
  at = await tap(thUser, 'kr:1:alpha-casino');
  check('th card from rankings: Thai name, Thai buttons, Thai URL', edits(at)[0]?.payload.text.startsWith('อัลฟ่าคาสิโน') &&
    JSON.stringify(rowLabels(buttons(at))) === JSON.stringify([['📖 อ่านรีวิว', '🌐 เยี่ยมชมเว็บไซต์'], ['📝 ส่งข้อร้องเรียน'], ['⬅️ ย้อนกลับ']]) &&
    buttons(at)[0][1].url === 'https://www.bc.gs/th/casinos/alpha-casino', rowLabels(buttons(at)));
  at = await tap(thUser, 'kv:1:alpha-casino');
  check('th review view from rankings: Thai labels, actions side by side, Back below', JSON.stringify(rowLabels(buttons(at))) ===
    JSON.stringify([['🌐 เยี่ยมชมเว็บไซต์', '📝 ร้องเรียน'], ['⬅️ ย้อนกลับ']]) &&
    JSON.stringify(shape(buttons(at))) === JSON.stringify([[url('alpha-casino', 'th'), 'cp:alpha-casino'], ['kr:1:alpha-casino']]), rowLabels(buttons(at)));
  at = await tap(thUser, 's:gone');
  check('th "no longer available"', unavailableOnly(at, th.buttons.unavailable));
  at = await send(textUpdate(thUser, '/links'));
  check('th links label', buttons(at)[0][0].text === '🌐 เว็บไซต์');

  console.log('\n== Buttons survive a restart (no in-memory state) ==');
  const restarted = await createOfflineBot();
  at = await restarted.send(tapUpdate(english, 'k:3'));
  check('fresh bot handles a rankings page button', edits(at)[0]?.payload.text.includes('11. India Casino') ?? false);
  at = await restarted.send(tapUpdate(english, 'sb', { replyToText: '/search casino' }));
  check('fresh bot handles Back to a search list', edits(at)[0]?.payload.text === listText);

  console.log('\n== Callback data size ==');
  const allData = calls.flatMap((c) => c.payload.reply_markup?.inline_keyboard?.flat() ?? []).map((b: any) => b.callback_data).filter(Boolean);
  const longest = allData.reduce((max: string, d: string) => (Buffer.byteLength(d) > Buffer.byteLength(max) ? d : max), '');
  check(`all ${allData.length} callback data sent are <= 64 bytes (longest ${Buffer.byteLength(longest)}: ${longest})`,
    allData.every((d: string) => Buffer.byteLength(d, 'utf8') <= MAX_CALLBACK_BYTES));
  check('every callback data sent decodes (navigation, flow or language button)',
    allData.every((d: string) => decodeNav(d) || decodeFlowButton(d) || d.startsWith('lang:')));
  check('encoder refuses data over 64 bytes instead of sending it', encodeNav({ kind: 'rankingsCard', page: 1, slug: 'x'.repeat(70) }) === null);
  check('round trip', JSON.stringify(decodeNav(encodeNav({ kind: 'rankingsCard', page: 3, slug: LONG, category: 'crypto' })!)) ===
    JSON.stringify({ kind: 'rankingsCard', page: 3, slug: LONG, category: 'crypto' }));
  check('every tap was answered exactly once', badAnswers.length === 0, badAnswers);

  console.log('\n== Labels fit in half a row ==');
  // Rough on-screen width: emoji and CJK take two cells, Thai vowel and tone marks take none.
  const width = (text: string) => [...text].reduce((sum, ch) =>
    sum + (/[\p{M}\uFE0F]/u.test(ch) ? 0 : /[\p{Extended_Pictographic}\p{Script=Han}\u3000-\u303F\uFF00-\uFFEF]/u.test(ch) ? 2 : 1), 0);
  // "📖 View Full Review" (19 cells) was cut off on a small phone; the widest requested label is "🌐 Visit Website".
  const cutOff = width('📖 View Full Review');
  const budget = width('🌐 Visit Website');
  const pairedLabels = calls.flatMap((c) => c.payload.reply_markup?.inline_keyboard ?? [])
    .filter((row: any[]) => row.length === 2).flat().map((b: any) => b.text as string);
  const tooWide = [...new Set(pairedLabels)].filter((text) => width(text) > budget);
  check(`every label sharing a row is no wider than "🌐 Visit Website" (${budget} cells, the cut-off one was ${cutOff}), ${new Set(pairedLabels).size} checked`,
    tooWide.length === 0 && budget < cutOff, tooWide.map((text) => `${text} = ${width(text)}`));
  for (const [name, catalog] of [['en', en], ['zh', zh], ['th', th]] as const) {
    const { unavailable, ...labels } = catalog.buttons;
    console.log(`  ${name}: ${Object.entries(labels).map(([key, text]) => `${key}=${text} (${width(text)})`).join(', ')}`);
  }
  check('short complaint label is no longer than the English one in every language',
    [zh, th].every((catalog) => width(catalog.buttons.complaintShort) <= width(en.buttons.complaintShort)),
    [en, zh, th].map((c) => `${c.buttons.complaintShort}=${width(c.buttons.complaintShort)}`));

  console.log('\n== Review keyboard built directly: every source, Back or not, missing website URL, groups ==');
  const { reviewKeyboard } = await import('../src/inline-keyboards');
  const ctxFor = (type: 'private' | 'supergroup') => ({ chat: { type }, me: { username: 'offline_bot' } }) as any;
  const rows = (kb: any) => (kb?.inline_keyboard ?? []) as any[][];
  const deepLink = 'url:https://t.me/offline_bot?start=complaint_stake';
  const sources = [
    ['/review (no Back)', undefined, null],
    ['search card', { kind: 'card', slug: 'stake' }, 'c:stake'],
    ['search list card', { kind: 'searchCard', slug: 'stake' }, 's:stake'],
    ['/review list', { kind: 'reviewBack' }, 'rb'],
    ['rankings card', { kind: 'rankingsCard', page: 2, slug: 'stake', category: 'crypto' }, 'kr:2:stake:crypto'],
  ] as const;
  const layoutProblems: string[] = [];
  for (const locale of ['en', 'zh', 'th'] as const) {
    const catalog = { en, zh, th }[locale];
    for (const chat of ['private', 'supergroup'] as const) {
      for (const [name, back, backData] of sources) {
        const kb = rows(reviewKeyboard(ctxFor(chat), 'stake', locale, back as any));
        const complaint = chat === 'private' ? 'cp:stake' : deepLink;
        const expected = [[url('stake', locale), complaint], ...(backData ? [[backData]] : [])];
        const labels = [[`🌐 ${catalog.buttons.visitWebsite}`, `📝 ${catalog.buttons.complaintShort}`], ...(backData ? [[`⬅️ ${catalog.buttons.back}`]] : [])];
        if (JSON.stringify(shape(kb)) !== JSON.stringify(expected) || JSON.stringify(rowLabels(kb)) !== JSON.stringify(labels)) {
          layoutProblems.push(`${locale}/${chat}/${name}: ${JSON.stringify(shape(kb))} ${JSON.stringify(rowLabels(kb))}`);
        }
        if (backData && encodeNav(back as any) !== backData) layoutProblems.push(`${name}: Back data ${encodeNav(back as any)}`);
      }
    }
  }
  check('30 combinations (en/zh/th × private/group × 5 sources): one action row, Back row only when opened from a card or list',
    layoutProblems.length === 0, layoutProblems);
  const noSite = rows(reviewKeyboard(ctxFor('private'), 'stake', 'en', { kind: 'card', slug: 'stake' }, ''));
  check('no website URL: Complaint alone on the first row, Back below', JSON.stringify(shape(noSite)) === JSON.stringify([['cp:stake'], ['c:stake']]) &&
    rowLabels(noSite)[0][0] === '📝 Complaint', shape(noSite));
  const noSiteGroup = rows(reviewKeyboard(ctxFor('supergroup'), 'stake', 'th', undefined, ''));
  check('no website URL in a group, no Back: just the deep-link Complaint', JSON.stringify(shape(noSiteGroup)) === JSON.stringify([[deepLink]]) &&
    rowLabels(noSiteGroup)[0][0] === '📝 ร้องเรียน', shape(noSiteGroup));
  check('cards still use the full "Submit Complaint" label', calls.some((c) =>
    (c.payload.reply_markup?.inline_keyboard ?? []).some((row: any[]) => row.length === 1 && row[0].text === '📝 Submit Complaint')));

  finish();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
