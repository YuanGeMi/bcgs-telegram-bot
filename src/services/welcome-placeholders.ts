export type WelcomeUser = { firstName?: string; lastName?: string; username?: string };

/** Control, zero-width and bidi-override characters: a name must not reorder or hide the surrounding text. */
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;

function cleanName(value: string | undefined): string {
  return (value ?? '').replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
}

function cleanUsername(value: string | undefined): string {
  const name = (value ?? '').trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,32}$/.test(name) ? name : '';
}

/** Cuts to `max` UTF-16 units without splitting a surrogate pair, marking the cut with "…". */
export function truncateForTelegram(value: string, max: number): string {
  if (value.length <= max) return value;
  let cut = value.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** Removes {username} (and an "@" typed before it) without leaving double spaces or a stray comma. */
function dropUsername(template: string): string {
  return template
    .replace(/[ \t]*\([ \t]*@?\{username\}[ \t]*\)/g, '')
    .replace(/(^|\n)[ \t]*@?\{username\}[ \t]*/g, '$1')
    .replace(/[ \t]*[,;:]?[ \t]*@?\{username\}(?=[ \t]*(?:[!?.,;:)\]]|\n|$))/g, '')
    .replace(/[ \t]*@?\{username\}/g, '');
}

/**
 * Fills {name}, {full_name} and {username} for the user, then applies Telegram's length limit.
 * The result is sent as plain text (no parse mode), so names can't add formatting or links.
 * Unknown placeholders are left as typed.
 */
export function renderWelcomeTemplate(template: string, user: WelcomeUser, fallbackName: string, max: number): string {
  const first = cleanName(user.firstName);
  const full = cleanName(`${first} ${cleanName(user.lastName)}`);
  const username = cleanUsername(user.username);

  const source = username ? template : dropUsername(template);
  const filled = source.replace(/(@?)\{(name|full_name|username)\}/g, (_match, at: string, key: string) => {
    if (key === 'username') return `@${username}`;
    return `${at}${key === 'name' ? first || fallbackName : full || fallbackName}`;
  });
  return truncateForTelegram(filled, max);
}
