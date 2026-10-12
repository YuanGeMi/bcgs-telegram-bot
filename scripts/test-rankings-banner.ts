// Offline test for the rankings banner (SiteSetting telegram_rankings_<locale>).
// Prisma and Telegram are both stubbed, so nothing reaches the database or Telegram.
// Run with: node --import tsx scripts/test-rankings-banner.ts
import {
  advanceMinutes, calls, check, createOfflineBot, db, failingMedia, failingMethods, finish, notModifiedMethods, settings, siteSettings,
  tapUpdate, textUpdate, type Call, type User,
} from './offline-harness';

(async () => {
  const { send } = await createOfflineBot();
  const en = (await import('../src/i18n/en')).default;
  const zh = (await import('../src/i18n/zh')).default;
  const th = (await import('../src/i18n/th')).default;
  const { t } = await import('../src/i18n');
  const { formatRating, casinoUrl } = await import('../src/site');
  const { parseRankingsBanner } = await import('../src/services/rankings-banner');
  const { formatCaption } = await import('../src/commands/rankings');
  const { prisma } = await import('../src/prisma');

  type Locale = 'en' | 'zh' | 'th';
  const SENDS = ['sendMessage', 'sendPhoto', 'sendAnimation', 'sendVideo'];
  const MEDIA_SENDS = ['sendPhoto', 'sendAnimation', 'sendVideo'];
  const EDITS = ['editMessageText', 'editMessageCaption'];
  const sent = (from: number): Call[] => calls.slice(from).filter((c) => SENDS.includes(c.method));
  const edits = (from: number): Call[] => calls.slice(from).filter((c) => EDITS.includes(c.method));
  const answers = (from: number): Call[] => calls.slice(from).filter((c) => c.method === 'answerCallbackQuery');
  const shape = (c: Call | undefined) =>
    (c?.payload.reply_markup?.inline_keyboard as any[][] | undefined)?.map((row) => row.map((b) => b.callback_data ?? b.url));
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const plain = (c: Call | undefined) => c?.payload.parse_mode === undefined && c?.payload.caption_entities === undefined &&
    c?.payload.entities === undefined;

  const BASE = 'https://proj.supabase.co/storage/v1/object/public/telegram-media/rankings';
  const PHOTO = `${BASE}/en/mfx1abc123def4.jpg`;
  const GIF = `${BASE}/en/mfx1abc123def5.gif`;
  const VIDEO = `${BASE}/en/mfx1abc123def6.mp4`;
  const ZH_PHOTO = `${BASE}/zh/mfx1abc123def7.png`;
  const TH_PHOTO = `${BASE}/th/mfx1abc123def8.webp`;
  let freshCount = 0;
  /** A URL never sent before, so no file_id is cached for it. */
  const fresh = (ext: string) => `${BASE}/en/fresh${freshCount++}abcdefgh.${ext}`;
  const FIELD: Record<string, string> = { sendPhoto: 'photo', sendAnimation: 'animation', sendVideo: 'video' };
  /** True if the media send used `url`, or a file_id Telegram returned for an earlier send of `url`. */
  const isFrom = (c: Call | undefined, url: string) => {
    if (!c || !FIELD[c.method]) return false;
    const field = FIELD[c.method];
    const ids = calls.filter((d) => d.method === c.method && d.payload[field] === url && d.result)
      .map((d) => (field === 'photo' ? d.result.photo.at(-1).file_id : d.result[field].file_id));
    return c.payload[field] === url || ids.includes(c.payload[field]);
  };
  const banner = (introText: string, mediaUrl: string | null, mediaType: string | null) => ({ introText, mediaUrl, mediaType });
  /** Stores the banner for `locale` (raw string, or an object to JSON-encode) and expires the cache. */
  const setBanner = (locale: Locale, value: unknown) => {
    if (value === undefined) siteSettings.delete(`telegram_rankings_${locale}`);
    else siteSettings.set(`telegram_rankings_${locale}`, typeof value === 'string' ? value : JSON.stringify(value));
    advanceMinutes(6);
  };
  const clearAll = () => (['en', 'zh', 'th'] as const).forEach((locale) => setBanner(locale, undefined));

  // Ranked by rating in the harness fixtures (12 published casinos, 5 per page).
  const RANKED = [
    ['stake', 4.6], ['roobet', 4.2], ['alpha-casino', 4.1], ['bravo-casino', 4.0], ['charlie-casino', 3.9], ['delta-casino', 3.8],
    ['echo-casino', 3.7], ['foxtrot-casino', 3.6], ['golf-casino', 3.5], ['hotel-casino', 3.4], ['india-casino', 3.3],
    ['the-extremely-long-casino-slug-example-2026', 3.2],
  ] as const;
  const NAMES: Record<Locale, string[]> = {
    en: ['Stake', 'Roobet', 'Alpha Casino', 'Bravo Casino', 'Charlie Casino', 'Delta Casino', 'Echo Casino', 'Foxtrot Casino', 'Golf Casino', 'Hotel Casino', 'India Casino', 'Juliet Casino'],
    zh: ['Stake 娱乐场', 'Roobet', '阿尔法娱乐场', 'Bravo Casino', 'Charlie Casino', 'Delta Casino', 'Echo Casino', 'Foxtrot Casino', 'Golf Casino', 'Hotel Casino', 'India Casino', 'Juliet Casino'],
    th: ['Stake', 'รูเบท', 'อัลฟ่าคาสิโน', 'Bravo Casino', 'Charlie Casino', 'Delta Casino', 'Echo Casino', 'Foxtrot Casino', 'Golf Casino', 'Hotel Casino', 'India Casino', 'Juliet Casino'],
  };
  /** The caption built independently of the code under test. */
  const expectedCaption = (locale: Locale, intro: string, page: number, title = t('rankings.topOverall', { count: 12 }, locale)) => {
    const first = (page - 1) * 5;
    const lines = RANKED.slice(first, first + 5).map(([, rating], index) =>
      `${first + index + 1}. ${NAMES[locale][first + index]} (${formatRating(rating, locale)})`);
    return [intro ? `${intro}\n\n${title}` : title, ...lines].join('\n');
  };
  const pageKeyboard = (page: number, category?: string) => {
    const first = (page - 1) * 5;
    const suffix = category ? `:${category}` : '';
    const rows: string[][] = RANKED.slice(first, first + 5).map(([slug]) => [`kr:${page}:${slug}${suffix}`]);
    rows.push([...(page > 1 ? [`k:${page - 1}${suffix}`] : []), ...(page < 3 ? [`k:${page + 1}${suffix}`] : [])]);
    return rows;
  };

  settings.set('3001', 'en');
  settings.set('3002', 'zh');
  settings.set('3003', 'th');
  const enUser: User = { id: 3001, language_code: 'en' };
  const zhUser: User = { id: 3002, language_code: 'en' };
  const thUser: User = { id: 3003, language_code: 'en' };
  const rankings = (user: User, args = '', chatType = 'private') =>
    send(textUpdate(user, args ? `/rankings ${args}` : '/rankings', chatType));
  const tap = (user: User, data: string, media?: 'photo' | 'animation' | 'video', chatType?: string) =>
    send(tapUpdate(user, data, { media, chatType }));

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };

  console.log('\n== Database down before anything was loaded: text rankings ==');
  const realSiteSetting = (prisma as any).siteSetting;
  Object.defineProperty(prisma, 'siteSetting', { value: { findMany: async () => { throw new Error('database down'); } }, configurable: true });
  setBanner('en', banner('Never seen', PHOTO, 'photo'));
  let at = await rankings(enUser);
  check('no cached copy and the database is down: the text ranking, with a short warning', sent(at).length === 1 &&
    sent(at)[0].method === 'sendMessage' && sent(at)[0].payload.text.startsWith('Top 12 casinos overall:') &&
    warnings.some((w) => w.includes('rankings banner')), sent(at).map((c) => c.method));
  Object.defineProperty(prisma, 'siteSetting', { value: realSiteSetting, configurable: true });

  console.log('\n== No banner: today\'s text ranking, unchanged ==');
  clearAll();
  const baseline: Record<string, Call> = {};
  for (const [user, locale] of [[enUser, 'en'], [zhUser, 'zh'], [thUser, 'th']] as const) {
    at = await rankings(user);
    baseline[locale] = sent(at)[0];
    check(`${locale}: one text message, the full ranking with links, no media`, sent(at).length === 1 &&
      baseline[locale].method === 'sendMessage' && baseline[locale].payload.text.includes(casinoUrl('stake', locale)) &&
      baseline[locale].payload.link_preview_options?.is_disabled === true && same(shape(baseline[locale]), pageKeyboard(1)) &&
      plain(baseline[locale]), baseline[locale]?.payload.text);
  }
  at = await rankings(enUser, 'crypto');
  const baselineCrypto = sent(at)[0];
  at = await tap(enUser, 'k:2');
  const baselinePage2 = edits(at)[0];
  check('old text message, Next: editMessageText as today', baselinePage2?.method === 'editMessageText' &&
    baselinePage2.payload.text.includes('6. Delta Casino (3.8/5)') && same(shape(baselinePage2), pageKeyboard(2)));

  console.log('\n== A banner in each media type ==');
  for (const [url, method, type] of [[PHOTO, 'sendPhoto', 'photo'], [GIF, 'sendAnimation', 'animation'], [VIDEO, 'sendVideo', 'video']] as const) {
    setBanner('en', banner('Our top picks this week!', url, type));
    at = await rankings(enUser);
    const out = sent(at);
    check(`${type}: one ${method} with the URL, the caption and today's buttons; no text message`,
      out.length === 1 && out[0].method === method && out[0].payload[type] === url &&
      out[0].payload.caption === expectedCaption('en', 'Our top picks this week!', 1) && same(shape(out[0]), pageKeyboard(1)) &&
      plain(out[0]), out.map((c) => [c.method, c.payload.caption]));
  }
  console.log(`  caption (en):\n${sent(at)[0].payload.caption.replace(/^/gm, '    | ')}`);

  console.log('\n== Bottom Rankings button ==');
  setBanner('en', banner('Our top picks this week!', PHOTO, 'photo'));
  at = await send(textUpdate(enUser, `🏆 ${en.keyboard.rankings}`));
  check('the menu button sends the banner too', sent(at).length === 1 && MEDIA_SENDS.includes(sent(at)[0].method) &&
    sent(at)[0].payload.caption === expectedCaption('en', 'Our top picks this week!', 1), sent(at).map((c) => c.method));

  console.log('\n== Empty intro: the built-in title line only ==');
  setBanner('en', banner('', PHOTO, 'photo'));
  at = await rankings(enUser);
  check('caption is the title and the casino lines', sent(at)[0]?.payload.caption === expectedCaption('en', '', 1), sent(at)[0]?.payload.caption);

  console.log('\n== Languages and the English fallback ==');
  setBanner('en', banner('English intro', PHOTO, 'photo'));
  setBanner('zh', banner('中文介绍', ZH_PHOTO, 'photo'));
  setBanner('th', banner('แนะนำภาษาไทย', TH_PHOTO, 'photo'));
  for (const [user, locale, url, intro] of [
    [enUser, 'en', PHOTO, 'English intro'], [zhUser, 'zh', ZH_PHOTO, '中文介绍'], [thUser, 'th', TH_PHOTO, 'แนะนำภาษาไทย'],
  ] as const) {
    at = await rankings(user);
    const out = sent(at)[0];
    check(`${locale}: its own banner, caption and buttons in ${locale}`, isFrom(out, url) &&
      out.payload.caption === expectedCaption(locale, intro, 1) &&
      out.payload.reply_markup.inline_keyboard.at(-1)[0].text === `▶️ ${({ en, zh, th })[locale].buttons.next}`, out?.payload.caption);
    console.log(`  caption (${locale}):\n${out?.payload.caption.replace(/^/gm, '    | ')}`);
  }
  setBanner('zh', undefined);
  at = await rankings(zhUser);
  check('Chinese not set: the English banner and intro, with the Chinese title, names and buttons',
    isFrom(sent(at)[0], PHOTO) && sent(at)[0].payload.caption === expectedCaption('zh', 'English intro', 1), sent(at)[0]?.payload.caption);
  setBanner('zh', '{"introText": "broken"');
  at = await rankings(zhUser);
  check('Chinese invalid: the English banner', isFrom(sent(at)[0], PHOTO));
  setBanner('en', undefined);
  at = await rankings(zhUser);
  check('Chinese and English not set: the Chinese text ranking, unchanged', sent(at).length === 1 &&
    same(sent(at)[0].payload, baseline.zh.payload), sent(at)[0]?.payload.text);
  at = await rankings(thUser);
  check('Thai set while English is not: the Thai banner', isFrom(sent(at)[0], TH_PHOTO) && !isFrom(sent(at)[0], PHOTO));
  clearAll();
  at = await rankings(enUser);
  check('everything cleared: byte-for-byte the text ranking from before', sent(at).length === 1 && same(sent(at)[0].payload, baseline.en.payload));

  console.log('\n== Invalid stored values: not set ==');
  const parse = (value: unknown) => parseRankingsBanner(typeof value === 'string' ? value : JSON.stringify(value));
  for (const [name, value] of [
    ['empty string', ''], ['spaces', '  '], ['invalid JSON', '{"introText":'], ['JSON array', '[]'], ['JSON string', '"x"'], ['null', 'null'],
    ['missing mediaUrl', { introText: 'Hi', mediaType: 'photo' }], ['null mediaUrl', banner('Hi', null, null)],
    ['http URL', banner('Hi', 'http://proj.supabase.co/x.jpg', 'photo')], ['not a URL', banner('Hi', 'banner.jpg', 'photo')],
    ['URL with spaces', banner('Hi', 'https://a.com/x y.jpg', 'photo')], ['unknown mediaType', banner('Hi', PHOTO, 'gif')],
    ['missing mediaType', { introText: 'Hi', mediaUrl: PHOTO }], ['intro over 300', banner('x'.repeat(301), PHOTO, 'photo')],
    ['intro not a string', { introText: 42, mediaUrl: PHOTO, mediaType: 'photo' }],
  ] as const) {
    check(`${name} → not set`, parse(value) === null, parse(value));
  }
  check('intro of exactly 300 is kept; trimmed; unknown fields dropped', same(parse({ ...banner(` ${'y'.repeat(300)} `, PHOTO, 'photo'), extra: 1 }),
    { introText: 'y'.repeat(300), media: { url: PHOTO, type: 'photo' } }));
  check('missing introText counts as empty', parse({ mediaUrl: GIF, mediaType: 'animation' })?.introText === '');
  setBanner('en', '{not json');
  at = await rankings(enUser);
  check('invalid JSON in the database: the text ranking', same(sent(at)[0]?.payload, baseline.en.payload));
  setBanner('en', banner('Hi', 'http://insecure.example/x.jpg', 'photo'));
  at = await rankings(enUser);
  check('http media URL in the database: the text ranking', same(sent(at)[0]?.payload, baseline.en.payload));

  console.log('\n== Caption limit ==');
  const casinosOf = (names: string[]) => names.map((name, index) => ({ slug: `c${index}`, name, overallRating: 4.5 - index / 10 }));
  const intro300 = `Intro ${'z'.repeat(294)}`;
  const longNames = casinosOf(Array.from({ length: 5 }, (_, i) => `Casino ${i + 1} ${'with an extremely long name '.repeat(12)}`));
  let caption = formatCaption(intro300, 'Top 12 casinos overall:', longNames, 1, 'en');
  check('300-character intro and five very long names: within 1024, intro and title intact, five lines, names cut with "…"',
    caption.length <= 1024 && caption.startsWith(`${intro300}\n\nTop 12 casinos overall:\n`) && caption.split('\n').length === 8 &&
    caption.split('\n').slice(3).every((line, i) => line.startsWith(`${i + 1}. Casino ${i + 1}`) && line.includes('…') && /\(\d\.\d\/5\)$/.test(line)),
    { length: caption.length, caption });
  const exact = formatCaption('', 'T', casinosOf(['a'.repeat(1024 - 'T\n1.  (4.5/5)'.length)]), 1, 'en');
  check('a caption of exactly 1024 is left whole', exact.length === 1024 && !exact.includes('…'), exact.length);
  const oneOver = formatCaption('', 'T', casinosOf(['a'.repeat(1025 - 'T\n1.  (4.5/5)'.length)]), 1, 'en');
  check('one character over: the name is cut, still 1024 or less', oneOver.length <= 1024 && oneOver.includes('…'), oneOver.length);
  const hugeTitle = `Top 12 casinos in ${'Very Long Category '.repeat(36)}:`;
  caption = formatCaption(intro300, hugeTitle, longNames, 1, 'en');
  check('header leaves room for fewer lines: extra lines dropped from the bottom, intro kept, within 1024',
    caption.length <= 1024 && caption.startsWith(intro300) && caption.split('\n').length < 8, { length: caption.length, lines: caption.split('\n').length });
  caption = formatCaption(intro300, 'X'.repeat(720), longNames, 1, 'en');
  check('no room for any line: intro and title only', caption === `${intro300}\n\n${'X'.repeat(720)}`, caption.length);
  caption = formatCaption('', 'Top', casinosOf(Array.from({ length: 5 }, () => '😀'.repeat(300))), 1, 'zh');
  check('emoji names: within 1024, no broken surrogate', caption.length <= 1024 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(caption), caption.length);
  check('short captions are untouched', formatCaption('Hi', 'Top', casinosOf(['A', 'B']), 1, 'en') === 'Hi\n\nTop\n1. A (4.5/5)\n2. B (4.4/5)');

  console.log('\n== Previous / Next ==');
  setBanner('en', banner('Banner intro', PHOTO, 'photo'));
  for (const media of ['photo', 'animation', 'video'] as const) {
    at = await tap(enUser, 'k:2', media);
    const out = edits(at);
    check(`${media} message, Next: editMessageCaption with page 2 and its buttons; nothing sent, the media stays`,
      out.length === 1 && out[0].method === 'editMessageCaption' && out[0].payload.caption === expectedCaption('en', 'Banner intro', 2) &&
      same(shape(out[0]), pageKeyboard(2)) && sent(at).length === 0 && plain(out[0]) &&
      !calls.slice(at).some((c) => c.method === 'editMessageMedia') && answers(at).length === 1, out.map((c) => c.method));
  }
  at = await tap(enUser, 'k:1', 'photo');
  check('media message, Previous: back to page 1', edits(at)[0]?.payload.caption === expectedCaption('en', 'Banner intro', 1) &&
    same(shape(edits(at)[0]), pageKeyboard(1)));
  at = await tap(enUser, 'k:3', 'photo');
  check('media message, last page: Previous only', same(shape(edits(at)[0]), pageKeyboard(3)) &&
    edits(at)[0].payload.caption.endsWith('12. Juliet Casino (3.2/5)'));
  at = await tap(enUser, 'k:2');
  check('old text message (banner now set), Next: editMessageText exactly as before', edits(at).length === 1 &&
    same(edits(at)[0].payload, baselinePage2.payload), edits(at)[0]?.method);

  console.log('\n== Tap a casino, then Back ==');
  at = await tap(enUser, 'kr:2:delta-casino', 'photo');
  let edit = edits(at)[0];
  check('media message: the caption becomes the card, the buttons the card buttons with Back to page 2', edits(at).length === 1 &&
    edit.method === 'editMessageCaption' && edit.payload.caption === `Delta Casino\nRating: 3.8/5\nLicense: ${en.search.noLicenses}\n${casinoUrl('delta-casino', 'en')}` &&
    same(shape(edit), [['kv:2:delta-casino', casinoUrl('delta-casino', 'en')], ['cp:delta-casino'], ['k:2']]) && sent(at).length === 0,
    [edit?.payload.caption, shape(edit)]);
  at = await tap(enUser, 'k:2', 'photo');
  check('media message, Back: the caption is page 2 again', edits(at)[0]?.payload.caption === expectedCaption('en', 'Banner intro', 2));
  at = await tap(enUser, 'kr:2:delta-casino');
  edit = edits(at)[0];
  check('text message: the card by editMessageText, as today', edit?.method === 'editMessageText' &&
    edit.payload.text.startsWith('Delta Casino\nRating: 3.8/5') && same(shape(edit), [['kv:2:delta-casino', casinoUrl('delta-casino', 'en')], ['cp:delta-casino'], ['k:2']]));
  at = await tap(enUser, 'k:2');
  check('text message, Back: page 2 text as today', same(edits(at)[0]?.payload, baselinePage2.payload));

  console.log('\n== Read Review ==');
  at = await tap(enUser, 'kv:2:delta-casino', 'photo');
  let out = sent(at);
  check('from a card on a media message: a new text message with the review, Visit Website and Complaint, no Back; nothing edited',
    out.length === 1 && out[0].method === 'sendMessage' && out[0].payload.text.startsWith('Delta Casino\nOverall rating: 3.8/5') &&
    same(shape(out[0]), [[casinoUrl('delta-casino', 'en'), 'cp:delta-casino']]) && edits(at).length === 0 && answers(at).length === 1 &&
    out[0].payload.reply_parameters === undefined, [out.map((c) => c.method), shape(out[0])]);
  at = await tap(enUser, 'kv:2:delta-casino');
  check('from a card on a text message: the review in place with Back to the card, as today', sent(at).length === 0 &&
    edits(at)[0]?.method === 'editMessageText' && same(shape(edits(at)[0]), [[casinoUrl('delta-casino', 'en'), 'cp:delta-casino'], ['kr:2:delta-casino']]));

  console.log('\n== Categories ==');
  at = await rankings(enUser, 'crypto');
  const cryptoTitle = t('rankings.topCategory', { count: 12, categoryName: 'Crypto Casinos' }, 'en');
  check('/rankings crypto: the banner, the category title in the caption, category buttons', sent(at)[0]?.method === 'sendPhoto' &&
    sent(at)[0].payload.caption === expectedCaption('en', 'Banner intro', 1, cryptoTitle) && same(shape(sent(at)[0]), pageKeyboard(1, 'crypto')),
    sent(at)[0]?.payload.caption);
  at = await tap(enUser, 'k:2:crypto', 'photo');
  check('media message, category Next: caption page 2 of the category', edits(at)[0]?.payload.caption === expectedCaption('en', 'Banner intro', 2, cryptoTitle) &&
    same(shape(edits(at)[0]), pageKeyboard(2, 'crypto')));
  at = await tap(enUser, 'kr:2:delta-casino:crypto', 'photo');
  check('category card on a media message: Back to the category page', same(shape(edits(at)[0])?.at(-1), ['k:2:crypto']));
  at = await rankings(enUser, 'no-such-category');
  check('unknown category: the "not found" text, no banner', sent(at).length === 1 && sent(at)[0].method === 'sendMessage' &&
    sent(at)[0].payload.text === t('rankings.categoryNotFound', { input: 'no-such-category' }, 'en'));
  setBanner('en', undefined);
  at = await rankings(enUser, 'crypto');
  check('category with no banner: unchanged', same(sent(at)[0]?.payload, baselineCrypto.payload));

  console.log('\n== Stale buttons ==');
  setBanner('en', banner('Banner intro', PHOTO, 'photo'));
  for (const data of ['k:9', 'kr:1:gone', 'kv:1:gone', 'k:1:no-such-category']) {
    at = await tap(enUser, data, 'photo');
    check(`${data} on a media message: "no longer available", nothing edited or sent`, edits(at).length === 0 && sent(at).length === 0 &&
      answers(at)[0]?.payload.text === en.buttons.unavailable);
  }
  setBanner('en', undefined);
  at = await tap(enUser, 'k:2', 'photo');
  check('banner removed since: its buttons still page, with the built-in caption', edits(at)[0]?.method === 'editMessageCaption' &&
    edits(at)[0].payload.caption === expectedCaption('en', '', 2));
  notModifiedMethods.add('editMessageCaption');
  at = await tap(enUser, 'k:2', 'photo');
  check('"message is not modified" on a caption: ignored, nothing sent, the tap answered without an error', sent(at).length === 0 &&
    answers(at).length === 1 && answers(at)[0].payload.text === undefined);
  notModifiedMethods.clear();
  notModifiedMethods.add('editMessageText');
  at = await tap(enUser, 'k:2');
  check('"message is not modified" on text: ignored, as before', sent(at).length === 0 && answers(at)[0]?.payload.text === undefined);
  notModifiedMethods.clear();
  failingMethods.add('editMessageCaption');
  at = await tap(enUser, 'k:2', 'photo');
  check('caption edit refused for another reason: the page is sent as a new text message', sent(at).length === 1 &&
    sent(at)[0].method === 'sendMessage' && sent(at)[0].payload.text.includes('6. Delta Casino (3.8/5)'));
  failingMethods.clear();

  console.log('\n== Media fails: text ranking, remembered for 10 minutes ==');
  warnings.length = 0;
  const BAD_VIDEO = fresh('mp4');
  setBanner('en', banner('Banner intro', BAD_VIDEO, 'video'));
  failingMedia.add(BAD_VIDEO);
  at = await rankings(enUser);
  out = sent(at);
  check('the video is tried once, then the normal text ranking', out.length === 2 && out[0].method === 'sendVideo' &&
    same(out[1].payload, baseline.en.payload), out.map((c) => c.method));
  check('a short warning without the URL', warnings.length === 1 && warnings[0].includes('video') && warnings[0].includes('400') &&
    !/https?:|supabase/.test(warnings[0]), warnings);
  advanceMinutes(4);
  at = await rankings(enUser);
  check('within 10 minutes: not tried again, straight to the text ranking', sent(at).length === 1 && sent(at)[0].method === 'sendMessage' &&
    warnings.length === 1);
  advanceMinutes(7);
  failingMedia.clear();
  at = await rankings(enUser);
  check('after 10 minutes: tried again, and sent', sent(at).length === 1 && sent(at)[0].method === 'sendVideo' && sent(at)[0].payload.video === BAD_VIDEO);
  failingMethods.add('sendPhoto');
  setBanner('en', banner('Banner intro', fresh('jpg'), 'photo'));
  at = await rankings(enUser);
  check('Telegram refuses the photo: text ranking', sent(at).length === 2 && sent(at)[1].method === 'sendMessage');
  setBanner('en', banner('Banner intro', PHOTO, 'photo'));
  at = await rankings(enUser);
  check('cached file_id and the URL both refused: one try each, then the text ranking', sent(at).length === 3 &&
    sent(at)[0].payload.photo.startsWith('fid-photo-') && sent(at)[1].payload.photo === PHOTO && sent(at)[2].method === 'sendMessage',
    sent(at).map((c) => c.payload.photo ?? c.method));
  failingMethods.clear();
  advanceMinutes(11);

  console.log('\n== file_id reuse ==');
  warnings.length = 0;
  const NEW_GIF = fresh('gif');
  setBanner('en', banner('Banner intro', NEW_GIF, 'animation'));
  at = await rankings(enUser);
  check('first send uses the URL', sent(at).length === 1 && sent(at)[0].payload.animation === NEW_GIF);
  const returnedId = 'fid-animation-';
  at = await rankings(enUser);
  const reused = sent(at)[0]?.payload.animation as string;
  check('second send reuses Telegram\'s file_id instead of the URL', sent(at).length === 1 && reused.startsWith(returnedId), reused);
  at = await rankings(zhUser);
  check('...also for another language using the same banner', sent(at)[0]?.payload.animation === reused);
  failingMedia.add(reused);
  at = await rankings(enUser);
  out = sent(at);
  check('file_id refused: dropped, the URL is used right away, the user still gets the banner', out.length === 2 &&
    out[0].payload.animation === reused && out[1].method === 'sendAnimation' && out[1].payload.animation === NEW_GIF, out.map((c) => c.payload.animation));
  check('...with a short warning, no URL', warnings.length === 1 && warnings[0].includes('file_id') && !/https?:/.test(warnings[0]), warnings);
  at = await rankings(enUser);
  const newId = sent(at)[0]?.payload.animation as string;
  check('next send uses the new file_id', sent(at).length === 1 && newId.startsWith(returnedId) && newId !== reused, newId);
  setBanner('en', banner('Banner intro', NEW_GIF, 'video'));
  at = await rankings(enUser);
  check('same URL as another media type: its own cache entry (the URL, not the animation file_id)', sent(at)[0]?.method === 'sendVideo' &&
    sent(at)[0].payload.video === NEW_GIF);
  failingMedia.clear();

  console.log('\n== Groups ==');
  setBanner('en', banner('Group intro', PHOTO, 'photo'));
  const groupUser: User = { id: 3100, language_code: 'en' };
  at = await rankings(groupUser, '', 'supergroup');
  check('group /rankings: the banner with 5 casinos and Next', sent(at)[0]?.method === 'sendPhoto' &&
    sent(at)[0].payload.caption === expectedCaption('en', 'Group intro', 1) && same(shape(sent(at)[0]), pageKeyboard(1)));
  at = await tap(groupUser, 'k:2', 'photo', 'supergroup');
  check('group Next on the banner: caption edit', edits(at)[0]?.method === 'editMessageCaption' &&
    edits(at)[0].payload.caption === expectedCaption('en', 'Group intro', 2));
  at = await tap(groupUser, 'kr:2:delta-casino', 'photo', 'supergroup');
  check('group card on the banner: complaint is the deep link, as before', same(shape(edits(at)[0])?.[1], ['https://t.me/offline_bot?start=complaint_delta-casino']));
  const spammer: User = { id: 3101, language_code: 'en' };
  let limited: Call | undefined;
  let edited = 0;
  for (let i = 0; i < 6; i += 1) {
    at = await tap(spammer, 'k:2', 'photo', 'supergroup');
    edited += edits(at).length;
    limited = answers(at)[0];
  }
  check('group rate limit still applies to banner taps: the 6th is refused without an edit', edited === 5 && limited?.payload.text === en.rateLimit.slowDown);

  console.log('\n== Cache ==');
  clearAll();
  setBanner('en', banner('Cached v1', PHOTO, 'photo'));
  const queriesBefore = db.siteSettingQueries;
  await rankings(enUser);
  await rankings(zhUser);
  await rankings(thUser);
  await tap(enUser, 'k:2', 'photo');
  check('three languages and a tap: one query for all three keys', db.siteSettingQueries - queriesBefore === 1, db.siteSettingQueries - queriesBefore);
  siteSettings.set('telegram_rankings_en', JSON.stringify(banner('Cached v2', PHOTO, 'photo')));
  advanceMinutes(4);
  at = await rankings(enUser);
  check('within 5 minutes: the cached copy', sent(at)[0]?.payload.caption.startsWith('Cached v1') && db.siteSettingQueries - queriesBefore === 1);
  advanceMinutes(2);
  at = await rankings(enUser);
  check('after 5 minutes: reloaded once', sent(at)[0]?.payload.caption.startsWith('Cached v2') && db.siteSettingQueries - queriesBefore === 2);
  Object.defineProperty(prisma, 'siteSetting', { value: { findMany: async () => { throw new Error('database down'); } }, configurable: true });
  advanceMinutes(6);
  at = await rankings(enUser);
  check('database down with a stale copy: the last good banner', sent(at)[0]?.payload.caption.startsWith('Cached v2'));
  Object.defineProperty(prisma, 'siteSetting', { value: realSiteSetting, configurable: true });

  console.log('\n== Untouched: /search and /review cards stay text ==');
  at = await send(textUpdate(enUser, '/search casino'));
  check('/search list: text', sent(at)[0]?.method === 'sendMessage');
  at = await tap(enUser, 's:delta-casino');
  check('/search card: editMessageText, Back = sb', edits(at)[0]?.method === 'editMessageText' && same(shape(edits(at)[0])?.at(-1), ['sb']));
  at = await tap(enUser, 'sv:delta-casino');
  check('/search card review: in place with Back', edits(at)[0]?.method === 'editMessageText' && same(shape(edits(at)[0])?.at(-1), ['s:delta-casino']));
  at = await send(textUpdate(enUser, '/review stake'));
  check('/review: text', sent(at)[0]?.method === 'sendMessage' && sent(at)[0].payload.text.startsWith('Stake'));

  console.warn = realWarn;
  finish();
})();
