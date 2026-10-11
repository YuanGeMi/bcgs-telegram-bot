// Offline test for the admin-edited /start welcome (SiteSetting telegram_welcome_<locale>).
// Prisma and Telegram are both stubbed, so nothing reaches the database or Telegram.
// Run with: node --import tsx scripts/test-welcome.ts
import {
  advanceMinutes, calls, check, createOfflineBot, db, failingMethods, failingTexts, finish, settings, siteSettings, tapUpdate, texts,
  textUpdate, type Call, type User,
} from './offline-harness';

(async () => {
  const { send } = await createOfflineBot();
  const en = (await import('../src/i18n/en')).default;
  const zh = (await import('../src/i18n/zh')).default;
  const th = (await import('../src/i18n/th')).default;
  const { t } = await import('../src/i18n');
  const { parseWelcome } = await import('../src/services/welcome');
  const { prisma } = await import('../src/prisma');

  const SENDS = ['sendMessage', 'sendPhoto', 'sendAnimation', 'sendVideo'];
  /** Messages sent to the user since `from`, in order. */
  const sent = (from: number): Call[] => calls.slice(from).filter((c) => SENDS.includes(c.method));
  const inline = (c: Call | undefined) => c?.payload.reply_markup?.inline_keyboard as { text: string; url: string }[][] | undefined;
  const hasReplyKeyboard = (c: Call | undefined) => Boolean(c?.payload.reply_markup?.keyboard);
  const MEDIA = 'https://proj.supabase.co/storage/v1/object/public/telegram-media/welcome/en-abc123def456.mp4';
  const PHOTO = MEDIA.replace('.mp4', '.jpg');
  const GIF = MEDIA.replace('.mp4', '.gif');
  const button = (n: number) => ({ label: `Button ${n}`, url: `https://t.me/bcgs${n}` });
  /** The harness names every user "Tester" unless the test sets first_name. */
  const GREET = 'Welcome Tester';
  /** A plain-text message carrying the bottom keyboard (and no inline buttons). */
  const isKeyboardText = (c: Call | undefined, text: string) =>
    c?.method === 'sendMessage' && c.payload.text === text && hasReplyKeyboard(c) && !inline(c) && c.payload.parse_mode === undefined;
  const isGreeting = (c: Call | undefined, text = GREET) => isKeyboardText(c, text);
  /** The short message that carries the inline buttons when there is no media for them. */
  const isLinks = (c: Call | undefined, buttons: number, text: string = en.app.welcomeButtons) =>
    c?.method === 'sendMessage' && c.payload.text === text && inline(c)?.length === buttons && !hasReplyKeyboard(c);
  const noGreeting = (out: Call[]) => !out.some((c) => typeof c.payload.text === 'string' && /^(Welcome|欢迎|ยินดีต้อนรับ)( .*)?$/.test(c.payload.text));
  const noFollowUp = (out: Call[]) => !out.some((c) => [en.keyboard.ready, zh.keyboard.ready, th.keyboard.ready].includes(c.payload.text));

  /** Stores the welcome for `locale` (raw string, or an object to JSON-encode) and expires the cache. */
  const setWelcome = (locale: string, value: unknown) => {
    if (value === undefined) siteSettings.delete(`telegram_welcome_${locale}`);
    else siteSettings.set(`telegram_welcome_${locale}`, typeof value === 'string' ? value : JSON.stringify(value));
    advanceMinutes(6);
  };
  const clearAll = () => ['en', 'zh', 'th'].forEach((locale) => setWelcome(locale, undefined));
  const welcome = (fields: Record<string, unknown>) => ({ text: '', caption: '', mediaUrl: null, mediaType: null, buttons: [], ...fields });

  settings.set('2001', 'en');
  settings.set('2002', 'zh');
  settings.set('2003', 'th');
  const enUser: User = { id: 2001, language_code: 'en' };
  const zhUser: User = { id: 2002, language_code: 'en' };
  const thUser: User = { id: 2003, language_code: 'en' };
  const start = (user: User) => send(textUpdate(user, '/start'));

  console.log('\n== Nothing set: built-in welcome unchanged ==');
  clearAll();
  let at = await start(enUser);
  let out = sent(at);
  check('one message: English help with the bottom keyboard, no inline buttons',
    out.length === 1 && out[0].payload.text === en.help.private && hasReplyKeyboard(out[0]) && !inline(out[0]), out);
  at = await start(zhUser);
  check('Chinese user gets the Chinese built-in help', sent(at).length === 1 && sent(at)[0].payload.text === zh.help.private);

  console.log('\n== Text only ==');
  setWelcome('en', welcome({ text: 'Hello from the admin panel!' }));
  at = await start(enUser);
  out = sent(at);
  check('zero buttons: one message, bottom keyboard rides on it, no greeting, no follow-up',
    out.length === 1 && out[0].payload.text === 'Hello from the admin panel!' && hasReplyKeyboard(out[0]) && noGreeting(out), out);
  check('plain text: no parse_mode', out.every((c) => c.payload.parse_mode === undefined));

  setWelcome('en', welcome({ text: 'Hi', buttons: [button(1)] }));
  out = sent(await start(enUser));
  check('text + button, no media: the welcome text is first and carries the bottom keyboard; no greeting', isKeyboardText(out[0], 'Hi') &&
    noGreeting(out), out[0]);
  check('...then the short links message carries the URL button, and nothing after it',
    out.length === 2 && isLinks(out[1], 1) &&
    JSON.stringify(inline(out[1])) === JSON.stringify([[{ text: 'Button 1', url: 'https://t.me/bcgs1' }]]) && noFollowUp(out), out);

  setWelcome('en', welcome({ text: 'Hi', buttons: [button(1), button(2), button(3)] }));
  out = sent(await start(enUser));
  check('three buttons: one per row, in order', JSON.stringify(inline(out[1])?.map((row) => row.map((b) => b.text))) ===
    JSON.stringify([['Button 1'], ['Button 2'], ['Button 3']]), inline(out[1]));

  setWelcome('en', welcome({ text: 'Hi {name} {username}!', buttons: [button(1)] }));
  out = sent(await start({ id: 2001, language_code: 'en', first_name: 'Ana', username: 'ana_s' }));
  check('placeholders filled in the first message, which carries the keyboard', isKeyboardText(out[0], 'Hi Ana @ana_s!'), out[0]?.payload.text);
  out = sent(await start({ id: 2001, language_code: 'en', first_name: '' }));
  check('...missing name and username use the existing rules', isKeyboardText(out[0], 'Hi there!'), out[0]?.payload.text);

  const MEDIA_CASES = [[PHOTO, 'sendPhoto', 'photo'], [GIF, 'sendAnimation', 'animation'], [MEDIA, 'sendVideo', 'video']] as const;

  console.log('\n== Both set: welcome text, then media with its own caption ==');
  for (const [url, method, type] of MEDIA_CASES) {
    setWelcome('en', welcome({ text: 'Short welcome', caption: 'Look at this', mediaUrl: url, mediaType: type, buttons: [button(1)] }));
    out = sent(await start(enUser));
    check(`${type}: the welcome text first, carrying the bottom keyboard; no greeting`,
      isKeyboardText(out[0], 'Short welcome') && noGreeting(out), out[0]);
    check(`${type}: then ${method} with its own caption and the buttons, and nothing after it`,
      out.length === 2 && out[1].method === method && out[1].payload[type] === url && out[1].payload.caption === 'Look at this' &&
      inline(out[1])?.length === 1 && !hasReplyKeyboard(out[1]) && noFollowUp(out), out.map((c) => c.method));
  }

  setWelcome('en', welcome({ text: 'Main text', caption: 'Photo caption', mediaUrl: PHOTO, mediaType: 'photo' }));
  out = sent(await start(enUser));
  check('both set, zero buttons: no greeting; text alone, then the photo with the bottom keyboard, no follow-up',
    out.length === 2 && out[0].payload.text === 'Main text' && out[0].payload.reply_markup === undefined &&
    out[1].method === 'sendPhoto' && out[1].payload.caption === 'Photo caption' && hasReplyKeyboard(out[1]), out);

  setWelcome('en', welcome({ text: 'Only the text', mediaUrl: PHOTO, mediaType: 'photo', buttons: [button(1)] }));
  out = sent(await start(enUser));
  check('caption empty: the photo has no caption; the welcome text is never reused as caption',
    isKeyboardText(out[0], 'Only the text') && out[1]?.method === 'sendPhoto' && out[1].payload.caption === undefined, out);

  const long = `Start. ${'Long welcome text. '.repeat(100)}End.`;
  setWelcome('en', welcome({ text: long, mediaUrl: MEDIA, mediaType: 'video', buttons: [button(1), button(2)] }));
  out = sent(await start(enUser));
  check('text over 1024 with media: full text uncut with the keyboard, then the video with both buttons, nothing after',
    out.length === 2 && isKeyboardText(out[0], long) && long.length > 1024 && out[1].method === 'sendVideo' &&
    inline(out[1])?.length === 2, out.map((c) => c.method));

  console.log('\n== Only media ==');
  setWelcome('en', welcome({ caption: 'Just a caption', mediaUrl: GIF, mediaType: 'animation', buttons: [button(1)] }));
  out = sent(await start(enUser));
  check('no text, media + caption + button: the greeting carries the keyboard, then the animation with caption and buttons, nothing after',
    out.length === 2 && isGreeting(out[0]) && out[1].method === 'sendAnimation' && out[1].payload.caption === 'Just a caption' &&
    inline(out[1])?.length === 1, out);
  setWelcome('en', welcome({ mediaUrl: PHOTO, mediaType: 'photo' }));
  out = sent(await start(enUser));
  check('media, no caption, no buttons: no greeting, photo without caption, keyboard on it', out.length === 1 && out[0].method === 'sendPhoto' &&
    out[0].payload.caption === undefined && hasReplyKeyboard(out[0]), out);

  console.log('\n== Only welcome ==');
  setWelcome('en', welcome({ text: 'Text only', caption: 'Orphan caption', buttons: [button(1)] }));
  out = sent(await start(enUser));
  check('caption without media is ignored: text with the keyboard, then the links message with the buttons, nothing after',
    out.length === 2 && isKeyboardText(out[0], 'Text only') && isLinks(out[1], 1) &&
    !out.some((c) => c.payload.text === 'Orphan caption' || c.payload.caption), out);

  console.log('\n== Media send fails ==');
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  failingMethods.add('sendPhoto');
  setWelcome('en', welcome({ text: 'Delivered first', caption: 'Lost caption', mediaUrl: PHOTO, mediaType: 'photo', buttons: [button(1)] }));
  at = await start(enUser);
  out = sent(at);
  check('the welcome text, with the keyboard, was delivered before the photo was tried',
    isKeyboardText(out[0], 'Delivered first') && out[1]?.method === 'sendPhoto', out.map((c) => c.method));
  check('the buttons go out on the links message instead (text and buttons), nothing after it',
    out.length === 3 && isLinks(out[2], 1) && noFollowUp(out) && noGreeting(out) &&
    JSON.stringify(inline(out[2])) === JSON.stringify([[{ text: 'Button 1', url: 'https://t.me/bcgs1' }]]), out.map((c) => c.method));
  check('no edit is attempted', !calls.slice(at).some((c) => c.method === 'editMessageReplyMarkup'));
  check('a short warning was logged, without the URL', warnings.length === 1 && warnings[0].includes('photo') &&
    warnings[0].includes('400') && !warnings[0].includes('supabase') && !warnings[0].includes('http'), warnings);

  setWelcome('en', welcome({ text: 'No buttons here', mediaUrl: PHOTO, mediaType: 'photo' }));
  at = await start(enUser);
  out = sent(at);
  check('zero buttons: no greeting; text, failed photo, then the follow-up carries the bottom keyboard (unchanged); no edit',
    out.length === 3 && out[0].payload.text === 'No buttons here' && out[2].payload.text === en.keyboard.ready && hasReplyKeyboard(out[2]) &&
    !calls.slice(at).some((c) => c.method === 'editMessageReplyMarkup'), out.map((c) => c.method));

  failingTexts.add(en.app.welcomeButtons);
  setWelcome('en', welcome({ text: 'Links fail too', mediaUrl: PHOTO, mediaType: 'photo', buttons: [button(1)] }));
  out = sent(await start(enUser));
  check('photo and the links message both fail: the handler carries on, the text is still delivered, nothing after',
    isKeyboardText(out[0], 'Links fail too') && out.length === 3 && noFollowUp(out) && !out.some((c) => c.payload.text === en.help.private),
    out.map((c) => c.method));
  failingTexts.clear();

  setWelcome('en', welcome({ caption: 'Lonely', mediaUrl: PHOTO, mediaType: 'photo', buttons: [button(1)] }));
  out = sent(await start(enUser));
  check('media-only welcome whose media fails: greeting, then the built-in welcome; /start is never silent',
    isGreeting(out[0]) && out.at(-1)?.payload.text === en.help.private && hasReplyKeyboard(out.at(-1)) && noFollowUp(out),
    out.map((c) => c.method));

  failingMethods.clear();
  warnings.length = 0;
  failingTexts.add('Text fails');
  setWelcome('en', welcome({ text: 'Text fails', caption: 'Media works', mediaUrl: PHOTO, mediaType: 'photo', buttons: [button(1)] }));
  out = sent(await start(enUser));
  check('first message (the text) fails: warning logged, the photo still goes out with its caption and buttons, nothing after',
    out.length === 2 && out[0].payload.text === 'Text fails' && out[1].method === 'sendPhoto' && out[1].payload.caption === 'Media works' &&
    inline(out[1])?.length === 1 && noGreeting(out) && noFollowUp(out) && warnings.length === 1 && warnings[0].includes('text'),
    out.map((c) => c.method));
  setWelcome('en', welcome({ text: 'Text fails', buttons: [button(1)] }));
  out = sent(await start(enUser));
  check('text fails, no media: the links message still goes out, nothing after', out.length === 2 && isLinks(out[1], 1) &&
    noFollowUp(out), out.map((c) => c.payload.text));
  failingTexts.clear();

  console.log('\n== Greeting (only when there is no welcome text) ==');
  warnings.length = 0;
  failingTexts.add(GREET);
  setWelcome('en', welcome({ caption: 'Still delivered', mediaUrl: PHOTO, mediaType: 'photo', buttons: [button(1)] }));
  out = sent(await start(enUser));
  check('greeting fails: the media is still sent with its caption and buttons, nothing after it',
    out.length === 2 && out[0].payload.text === GREET && out[1].method === 'sendPhoto' && out[1].payload.caption === 'Still delivered' &&
    inline(out[1])?.length === 1 && noFollowUp(out), out.map((c) => c.method));
  check('...and a short warning was logged', warnings.length === 1 && warnings[0].includes('greeting') && warnings[0].length < 300, warnings);
  failingTexts.clear();
  console.warn = realWarn;

  for (const [firstName, expected, label] of [
    ['', 'Welcome', 'no first name'],
    ['   ', 'Welcome', 'blank first name'],
    ['  Ana  ', 'Welcome Ana', 'first name trimmed'],
    ['A'.repeat(100), `Welcome ${'A'.repeat(64)}`, 'long first name cut to 64'],
    ['😀'.repeat(70), `Welcome ${'😀'.repeat(64)}`, 'long emoji name cut to 64 characters without splitting one'],
    ['*Ana* <b>x</b>', 'Welcome *Ana* <b>x</b>', 'formatting characters kept as plain text'],
  ] as const) {
    out = sent(await start({ id: 2001, language_code: 'en', first_name: firstName }));
    check(`${label} → ${JSON.stringify(expected.slice(0, 24))}`, isGreeting(out[0], expected) && out[1]?.payload.caption === 'Still delivered',
      out[0]?.payload.text);
  }

  setWelcome('zh', welcome({ caption: '中文欢迎', mediaUrl: PHOTO, mediaType: 'photo', buttons: [button(1)] }));
  setWelcome('th', welcome({ caption: 'ข้อความต้อนรับ', mediaUrl: PHOTO, mediaType: 'photo', buttons: [button(1)] }));
  for (const [user, greeting, noName, caption] of [
    [enUser, 'Welcome Tester', 'Welcome', 'Still delivered'],
    [zhUser, '欢迎 Tester', '欢迎', '中文欢迎'],
    [thUser, 'ยินดีต้อนรับ Tester', 'ยินดีต้อนรับ', 'ข้อความต้อนรับ'],
  ] as const) {
    out = sent(await start(user));
    check(`${user.id}: greeting ${JSON.stringify(greeting)} with the keyboard in the user's language, then the media`,
      out.length === 2 && isGreeting(out[0], greeting) && out[1].payload.caption === caption, out.map((c) => c.payload.text ?? c.method));
    out = sent(await start({ ...user, first_name: '' }));
    check(`${user.id}: no first name → ${JSON.stringify(noName)}`, isGreeting(out[0], noName), out[0]?.payload.text);
  }
  check('greeting keyboard uses the user\'s language labels',
    JSON.stringify(sent(await start(thUser))[0]?.payload.reply_markup?.keyboard).includes(th.keyboard.search));

  setWelcome('en', welcome({ text: 'EN text', buttons: [button(1)] }));
  setWelcome('zh', welcome({ text: '中文文本', buttons: [button(1)] }));
  setWelcome('th', welcome({ text: 'ข้อความไทย', buttons: [button(1)] }));
  for (const [user, text, links, keyLabel] of [
    [enUser, 'EN text', en.app.welcomeButtons, en.keyboard.search],
    [zhUser, '中文文本', zh.app.welcomeButtons, zh.keyboard.search],
    [thUser, 'ข้อความไทย', th.app.welcomeButtons, th.keyboard.search],
  ] as const) {
    out = sent(await start(user));
    check(`${user.id}: welcome text first with the keyboard in its language, then the localized links message ${JSON.stringify(links)}`,
      out.length === 2 && isKeyboardText(out[0], text) && JSON.stringify(out[0].payload.reply_markup?.keyboard).includes(keyLabel) &&
      isLinks(out[1], 1, links) && noGreeting(out), out.map((c) => c.payload.text));
  }
  setWelcome('en', undefined);
  setWelcome('zh', undefined);
  setWelcome('th', undefined);

  console.log('\n== Placeholders ==');
  const { renderWelcomeTemplate } = await import('../src/services/welcome-placeholders');
  const ana = { firstName: 'Ana', lastName: 'Silva', username: 'ana_s' };
  const noUser = { firstName: 'Ana', lastName: 'Silva' };
  const r = (template: string, user: Parameters<typeof renderWelcomeTemplate>[1], max = 4096) =>
    renderWelcomeTemplate(template, user, 'there', max);
  for (const [template, user, expected] of [
    ['Hi {name} ({full_name}) {username}!', ana, 'Hi Ana (Ana Silva) @ana_s!'],
    ['Hi @{username}', ana, 'Hi @ana_s'],
    ['Hi {name} {username}!', noUser, 'Hi Ana!'],
    ['Hello, {username}!', noUser, 'Hello!'],
    ['Hi {username}, welcome', noUser, 'Hi, welcome'],
    ['{username} welcome', noUser, 'welcome'],
    ['Hi @{username} and welcome', noUser, 'Hi and welcome'],
    ['Contact ({username}) now', noUser, 'Contact now'],
    ['Line one\n{username}\nLine three', noUser, 'Line one\n\nLine three'],
    ['Hi {name}, {full_name}', { firstName: '', lastName: '' }, 'Hi there, there'],
    ['Hi {name}, {full_name}', { firstName: '   ' }, 'Hi there, there'],
    ['{full_name}', { firstName: 'Ana' }, 'Ana'],
    ['Hi {name}', { firstName: '<b>Bold</b> *x* [link](https://evil.example) _u_ `c`' }, 'Hi <b>Bold</b> *x* [link](https://evil.example) _u_ `c`'],
    ['Hi {name}!', { firstName: 'A\u202Eevil\u0000\u200B' }, 'Hi Aevil!'],
    ['Hi {name}', { firstName: '{username}', username: 'ana_s' }, 'Hi {username}'],
    ['Hi {username}!', { firstName: 'Ana', username: 'bad name!' }, 'Hi!'],
    ['Hi {nickname} {NAME} {name', ana, 'Hi {nickname} {NAME} {name'],
  ] as const) {
    const got = r(template, user);
    check(`${JSON.stringify(template)} → ${JSON.stringify(expected)}`, got === expected, got);
  }
  const template4096 = `${'x'.repeat(4080)} {full_name}`;
  const longText = r(template4096, { firstName: 'Ana', lastName: 'Silva-Montenegro' });
  check('template fits, but the filled text is over 4096: cut to ≤ 4096 with "…"', template4096.length <= 4096 &&
    longText.length <= 4096 && longText.length >= 4090 && longText.endsWith('…') && longText.includes(' Ana'), longText.length);
  const longCaption = r(`${'y'.repeat(1018)}{name}`, { firstName: 'Anastasia' }, 1024);
  check('caption cut to ≤ 1024 after substitution', longCaption.length === 1024 && longCaption.endsWith('…') &&
    longCaption.includes('Anast'), longCaption.length);
  const emoji = r(`${'a'.repeat(1022)}😀😀`, ana, 1024);
  check('cut never splits an emoji', emoji.length <= 1024 && !/[\uD800-\uDBFF]…$/.test(emoji) && emoji.endsWith('…'), emoji.slice(-4));
  check('short text is not touched', r('Hi {name}', ana) === 'Hi Ana');

  setWelcome('en', welcome({ text: 'Hi {name} {username}!', caption: 'For {full_name}', mediaUrl: PHOTO, mediaType: 'photo' }));
  const named: User = { id: 2001, language_code: 'en', first_name: 'Ana *bold*', last_name: '[x](https://evil.example)', username: 'ana_s' };
  out = sent(await start(named));
  check('/start fills placeholders in the text and the caption', out[0]?.payload.text === 'Hi Ana *bold* @ana_s!' &&
    out[1]?.payload.caption === 'For Ana *bold* [x](https://evil.example)', out.map((c) => c.payload.text ?? c.payload.caption));
  check('...sent as plain text: no parse_mode, no entities', out.every((c) => c.payload.parse_mode === undefined &&
    c.payload.entities === undefined && c.payload.caption_entities === undefined));
  out = sent(await start({ id: 2001, language_code: 'en', first_name: '' }));
  check('no name, no username: fallback word and no dangling "@"', out[0]?.payload.text === 'Hi there!' &&
    out[1]?.payload.caption === 'For there', out.map((c) => c.payload.text ?? c.payload.caption));

  console.log('\n== Invalid values ==');
  const parse = (value: unknown) => parseWelcome(typeof value === 'string' ? value : JSON.stringify(value));
  for (const [name, value] of [
    ['empty string', ''], ['spaces', '   '], ['invalid JSON', '{"text": "hi"'], ['JSON array', '[1,2]'], ['JSON string', '"hello"'],
    ['null', 'null'], ['no text or media', { caption: 'only caption', buttons: [button(1)] }], ['text over 4096', { text: 'x'.repeat(4097) }],
  ] as const) {
    check(`${name} → not set`, parse(value) === null, parse(value));
  }
  const dirty = parse({
    text: '  Hi  ', caption: 'c'.repeat(1025), mediaUrl: 'http://insecure.example/x.jpg', mediaType: 'photo', extra: 'ignored',
    buttons: [
      { label: 'x'.repeat(31), url: 'https://a.com' }, { label: 'Http', url: 'http://a.com' }, { label: 'Tg', url: 'tg://resolve?domain=x' },
      { label: '', url: 'https://a.com' }, 'not an object', null, { label: 'Good 1', url: 'https://good.com/1' },
      { label: 'Good 2', url: 'https://t.me/x' }, { label: 'Good 3', url: 'https://good.com/3' }, { label: 'Good 4', url: 'https://good.com/4' },
    ],
  });
  check('invalid fields dropped, valid ones kept, text trimmed', JSON.stringify(dirty) === JSON.stringify({
    text: 'Hi', caption: '', media: null,
    buttons: [{ label: 'Good 1', url: 'https://good.com/1' }, { label: 'Good 2', url: 'https://t.me/x' }, { label: 'Good 3', url: 'https://good.com/3' }],
  }), dirty);
  check('unknown mediaType drops the media', parse({ text: 'Hi', mediaUrl: PHOTO, mediaType: 'gif' })?.media === null);
  check('non-string text dropped', parse({ text: 42, mediaUrl: PHOTO, mediaType: 'photo' })?.text === '');

  setWelcome('en', '{not json');
  out = sent(await start(enUser));
  check('invalid JSON in the database: built-in welcome', out.length === 1 && out[0].payload.text === en.help.private);

  console.log('\n== Language fallback ==');
  setWelcome('en', welcome({ text: 'English welcome' }));
  setWelcome('th', welcome({ text: 'ยินดีต้อนรับ' }));
  out = sent(await start(zhUser));
  check('Chinese not set: English welcome', out[0]?.payload.text === 'English welcome', out);
  out = sent(await start(thUser));
  check('Thai set: Thai welcome', out[0]?.payload.text === 'ยินดีต้อนรับ', out);
  setWelcome('zh', '[]');
  out = sent(await start(zhUser));
  check('Chinese invalid: English welcome', out[0]?.payload.text === 'English welcome');
  setWelcome('en', undefined);
  out = sent(await start(zhUser));
  check('Chinese and English not set: Chinese built-in welcome', out.length === 1 && out[0].payload.text === zh.help.private);

  setWelcome('en', welcome({ text: 'Hello {name}' }));
  setWelcome('zh', welcome({ text: '你好，{name}' }));
  setWelcome('th', welcome({ text: 'สวัสดี{name}' }));
  for (const [user, expected] of [
    [{ id: 2001, language_code: 'en', first_name: '' }, `Hello ${en.app.nameFallback}`],
    [{ id: 2002, language_code: 'en', first_name: '' }, `你好，${zh.app.nameFallback}`],
    [{ id: 2003, language_code: 'en', first_name: '' }, `สวัสดี${th.app.nameFallback}`],
  ] as const) {
    out = sent(await start(user));
    check(`no name: fallback word in the user's language → ${JSON.stringify(expected)}`, out[0]?.payload.text === expected, out[0]?.payload.text);
  }
  setWelcome('zh', undefined);
  out = sent(await start({ id: 2002, language_code: 'en', first_name: '' }));
  check('Chinese falls back to the English welcome, with the Chinese fallback word', out[0]?.payload.text === `Hello ${zh.app.nameFallback}`,
    out[0]?.payload.text);
  setWelcome('en', undefined);
  setWelcome('th', undefined);

  console.log('\n== Cache ==');
  clearAll();
  setWelcome('en', welcome({ text: 'Cached v1' }));
  const queriesBefore = db.siteSettingQueries;
  await start(enUser);
  await start(zhUser);
  await start(thUser);
  await start(enUser);
  check('four /starts in three languages: one query for all three keys', db.siteSettingQueries - queriesBefore === 1,
    db.siteSettingQueries - queriesBefore);
  siteSettings.set('telegram_welcome_en', JSON.stringify(welcome({ text: 'Cached v2' })));
  advanceMinutes(4);
  out = sent(await start(enUser));
  check('within 5 minutes: still the cached copy, no new query', out[0]?.payload.text === 'Cached v1' && db.siteSettingQueries - queriesBefore === 1);
  advanceMinutes(2);
  out = sent(await start(enUser));
  check('after 5 minutes: reloaded once, new copy', out[0]?.payload.text === 'Cached v2' && db.siteSettingQueries - queriesBefore === 2);

  const realSiteSetting = (prisma as any).siteSetting;
  Object.defineProperty(prisma, 'siteSetting', {
    value: { findMany: async () => { throw new Error('database down'); } }, configurable: true,
  });
  console.warn = () => {};
  advanceMinutes(6);
  out = sent(await start(enUser));
  check('database down with a stale copy: stale welcome still sent', out[0]?.payload.text === 'Cached v2', out);
  console.warn = realWarn;
  Object.defineProperty(prisma, 'siteSetting', { value: realSiteSetting, configurable: true });

  console.log('\n== First-time language pick, then the welcome ==');
  setWelcome('zh', welcome({ text: '欢迎！', buttons: [button(1)] }));
  const newUser: User = { id: 2100, language_code: 'zh' };
  at = await start(newUser);
  check('new user /start: language selector, no welcome yet', sent(at).length === 1 && !sent(at).some((c) => c.payload.text === '欢迎！'));
  at = await send(tapUpdate(newUser, 'lang:zh:start'));
  out = sent(at);
  check('after picking Chinese: confirmation edit, then the Chinese welcome text with the keyboard, then the links message, nothing after',
    texts(at)[0] === zh.language.saved && isKeyboardText(out[0], '欢迎！') && isLinks(out[1], 1, zh.app.welcomeButtons) &&
    out.length === 2 && noGreeting(out) && noFollowUp(out), texts(at));
  check('chat command menu still synced once', calls.slice(at).filter((c) => c.method === 'setMyCommands').length === 1);

  const otherNew: User = { id: 2101, language_code: 'en' };
  await start(otherNew);
  at = await send(tapUpdate(otherNew, 'lang:th:start'));
  setWelcome('th', undefined);
  setWelcome('en', undefined);
  const thaiNew: User = { id: 2102, language_code: 'en' };
  await start(thaiNew);
  at = await send(tapUpdate(thaiNew, 'lang:th:start'));
  check('nothing set: first pick shows the built-in Thai help with the keyboard, as before',
    texts(at)[0] === th.language.saved && texts(at)[1] === th.help.private && sent(at).length === 1 && hasReplyKeyboard(sent(at)[0]), texts(at));

  console.log('\n== Unchanged: /start parameters, /menu, groups ==');
  setWelcome('en', welcome({ text: 'Custom EN', mediaUrl: PHOTO, mediaType: 'photo', buttons: [button(1)] }));
  const noWelcome = (from: number) => noGreeting(sent(from)) &&
    !sent(from).some((c) => c.method === 'sendPhoto' || c.payload.text === 'Custom EN' || c.payload.caption === 'Custom EN');
  at = await send(textUpdate(enUser, '/start complaint'));
  check('/start complaint: complaint flow, no welcome', texts(at)[0] === t('complaint.start', { label: 'complaint' }, 'en') && noWelcome(at), texts(at));
  await send(textUpdate(enUser, '/cancel'));
  at = await send(textUpdate(enUser, '/start report'));
  check('/start report: report flow, no welcome', texts(at)[0]?.startsWith(t('complaint.start', { label: t('complaint.typeReport', {}, 'en') }, 'en')) && noWelcome(at), texts(at));
  await send(textUpdate(enUser, '/cancel'));
  at = await send(textUpdate(enUser, '/start complaint_stake'));
  check('/start complaint_<slug>: preselected complaint, no welcome', texts(at)[0]?.includes('Stake') && noWelcome(at), texts(at));
  await send(textUpdate(enUser, '/cancel'));
  at = await send(textUpdate(enUser, '/start language'));
  check('/start language: language selector, no welcome', texts(at)[0] === ['en', 'zh', 'th'].map((l) => t('language.choose', {}, l as 'en')).join('\n') && noWelcome(at));
  at = await send(textUpdate(enUser, '/menu'));
  check('/menu: unchanged keyboard message, no welcome', sent(at).length === 1 && texts(at)[0] === en.keyboard.ready && hasReplyKeyboard(sent(at)[0]) && noWelcome(at));
  at = await send(textUpdate(enUser, '/help'));
  check('/help: unchanged', texts(at)[0] === en.help.private && noWelcome(at));
  at = await send(tapUpdate(enUser, 'lang:en'));
  check('language selector change (no start): keyboard.ready as before, no welcome', texts(at).includes(en.keyboard.ready) && noWelcome(at), texts(at));

  const groupUser: User = { id: 2200, language_code: 'en' };
  at = await send(textUpdate(groupUser, '/start', 'supergroup'));
  check('group /start: group help only, no welcome, no keyboard', sent(at).length === 1 && texts(at)[0] === en.help.group &&
    !hasReplyKeyboard(sent(at)[0]) && noWelcome(at), texts(at));

  finish();
})();
