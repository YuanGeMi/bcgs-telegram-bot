// Every inline-button callback format lives here. Telegram caps callback data at 64 bytes,
// so buttons carry only ids/slugs and short codes; all state is in the data, so buttons survive a restart.
//
// Casino cards (Read Review opens the review in the same message; its Back reopens the card):
//   c:<slug>                       card of a single /search result (no Back)          Read Review = v:<slug>
//   s:<slug>                       card opened from a /search list (Back = sb)         Read Review = sv:<slug>
//   kr:<page>:<slug>[:<category>]  card opened from a rankings page (Back = k:...)     Read Review = kv:<page>:<slug>[:<category>]
//   v: / sv: / kv:                 the review opened from that card (Back = the card's own data)
//
// The same k:/kr:/kv: buttons sit on the rankings banner (a photo, GIF or video): there they edit its caption,
// and kv: sends the review as a new message without Back. The handler tells the two apart by the tapped message.
//
//   sb                             back to the /search list (query is read from the message being replied to)
//   r:<slug>                       open a casino review from a /review list (Back = rb)
//   rb                             back to the /review list (same as sb)
//   k:<page>[:<category>]          rankings page, overall or for a category slug
//   cp[:<slug>]                    start the complaint flow, with that casino preselected when a slug is given
//                                  (private chats only; groups get a URL button, see complaintStartParameter)
//   lang:<locale>[:<after>[:<slug>]]  language choice (see commands/language.ts); the slug only follows "complaint"
//   f:<flow>:<answer>              a button in a complaint/report flow; <flow> is a random id per flow, so buttons
//                                  from a flow that ended are recognized; answers: see FlowAnswer
//
// /start deep-link parameters (Telegram allows at most 64 characters of A-Z a-z 0-9 _ -):
//   complaint | complaint_<slug> | report | language

export const MAX_CALLBACK_BYTES = 64;

/** A casino card, identified by where it was opened from (which decides its Back button). */
export type CardAction =
  | { kind: 'card'; slug: string }
  | { kind: 'searchCard'; slug: string }
  | { kind: 'rankingsCard'; page: number; slug: string; category?: string };

export type NavAction =
  | CardAction
  | { kind: 'cardReview'; card: CardAction }
  | { kind: 'searchBack' }
  | { kind: 'reviewOpen'; slug: string }
  | { kind: 'reviewBack' }
  | { kind: 'rankingsPage'; page: number; category?: string }
  | { kind: 'complaint'; slug?: string };

const SLUG = '[^:\\s]+';
const PAGE = '[1-9]\\d{0,2}';

function fits(data: string): string | null {
  return Buffer.byteLength(data, 'utf8') <= MAX_CALLBACK_BYTES ? data : null;
}

/** Callback data for an action, or null if it wouldn't fit in 64 bytes (the button is then left out). */
export function encodeNav(action: NavAction): string | null {
  const category = 'category' in action && action.category ? `:${action.category}` : '';
  switch (action.kind) {
    case 'card':
      return fits(`c:${action.slug}`);
    case 'searchCard':
      return fits(`s:${action.slug}`);
    case 'rankingsCard':
      return fits(`kr:${action.page}:${action.slug}${category}`);
    case 'cardReview': {
      const card = encodeNav(action.card);
      const prefix = { card: 'v', searchCard: 'sv', rankingsCard: 'kv' }[action.card.kind];
      return card ? fits(`${prefix}${card.slice(card.indexOf(':'))}`) : null;
    }
    case 'searchBack':
      return 'sb';
    case 'reviewOpen':
      return fits(`r:${action.slug}`);
    case 'reviewBack':
      return 'rb';
    case 'rankingsPage':
      return fits(`k:${action.page}${category}`);
    case 'complaint':
      // Too long for a preselected casino: the button still works, the flow just asks for the casino.
      return (action.slug && fits(`cp:${action.slug}`)) || 'cp';
  }
}

const RANKINGS_CARD = `(${PAGE}):(${SLUG})(?::(${SLUG}))?`;
const rankingsCard = (m: RegExpMatchArray): CardAction =>
  ({ kind: 'rankingsCard', page: Number(m[1]), slug: m[2], category: m[3] });

const patterns: [RegExp, (m: RegExpMatchArray) => NavAction][] = [
  [new RegExp(`^c:(${SLUG})$`), (m) => ({ kind: 'card', slug: m[1] })],
  [new RegExp(`^s:(${SLUG})$`), (m) => ({ kind: 'searchCard', slug: m[1] })],
  [new RegExp(`^kr:${RANKINGS_CARD}$`), rankingsCard],
  [new RegExp(`^v:(${SLUG})$`), (m) => ({ kind: 'cardReview', card: { kind: 'card', slug: m[1] } })],
  [new RegExp(`^sv:(${SLUG})$`), (m) => ({ kind: 'cardReview', card: { kind: 'searchCard', slug: m[1] } })],
  [new RegExp(`^kv:${RANKINGS_CARD}$`), (m) => ({ kind: 'cardReview', card: rankingsCard(m) })],
  [/^sb$/, () => ({ kind: 'searchBack' })],
  [new RegExp(`^r:(${SLUG})$`), (m) => ({ kind: 'reviewOpen', slug: m[1] })],
  [/^rb$/, () => ({ kind: 'reviewBack' })],
  [new RegExp(`^k:(${PAGE})(?::(${SLUG}))?$`), (m) => ({ kind: 'rankingsPage', page: Number(m[1]), category: m[2] })],
  [new RegExp(`^cp(?::(${SLUG}))?$`), (m) => ({ kind: 'complaint', slug: m[1] })],
];

/** The action for callback data, or null if it isn't a navigation button (or is malformed). */
export function decodeNav(data: string): NavAction | null {
  for (const [pattern, build] of patterns) {
    const match = data.match(pattern);
    if (match) return build(match);
  }
  return null;
}

/** y/n = yes/no, p1..p5 = casino choice, x = none of these, d = done, s = skip, ok = confirm, c = cancel. */
export type FlowAnswer = 'y' | 'n' | 'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'x' | 'd' | 's' | 'ok' | 'c';

export const FLOW_CALLBACK_PATTERN = /^f:([a-z0-9]{1,12}):(y|n|p[1-5]|x|d|s|ok|c)$/;

export function encodeFlowButton(flowId: string, answer: FlowAnswer): string {
  return `f:${flowId}:${answer}`;
}

export function decodeFlowButton(data: string): { flowId: string; answer: FlowAnswer } | null {
  const match = data.match(FLOW_CALLBACK_PATTERN);
  return match ? { flowId: match[1], answer: match[2] as FlowAnswer } : null;
}

export const LANGUAGE_CALLBACK_PATTERN = new RegExp(`^lang:([a-z]+)(?::(start|complaint|report))?(?::(${SLUG}))?$`);

export function encodeLanguage(locale: string, after?: string, slug?: string): string {
  const base = after ? `lang:${locale}:${after}` : `lang:${locale}`;
  return (after === 'complaint' && slug && fits(`${base}:${slug}`)) || base;
}

const MAX_START_PARAMETER = 64;
const START_PARAMETER = /^[A-Za-z0-9_-]+$/;
const COMPLAINT_PREFIX = 'complaint_';

/** /start parameter for the complaint deep link; plain "complaint" when the slug isn't allowed or doesn't fit. */
export function complaintStartParameter(slug?: string): string {
  const parameter = slug ? `${COMPLAINT_PREFIX}${slug}` : 'complaint';
  return parameter.length <= MAX_START_PARAMETER && START_PARAMETER.test(parameter) ? parameter : 'complaint';
}

export type StartPayload =
  | { kind: 'complaint'; slug?: string }
  | { kind: 'report' }
  | { kind: 'language' }
  | { kind: 'none' };

export function decodeStartParameter(parameter: string): StartPayload {
  if (parameter === 'complaint') return { kind: 'complaint' };
  if (parameter.startsWith(COMPLAINT_PREFIX) && START_PARAMETER.test(parameter)) {
    const slug = parameter.slice(COMPLAINT_PREFIX.length);
    return slug ? { kind: 'complaint', slug } : { kind: 'complaint' };
  }
  if (parameter === 'report') return { kind: 'report' };
  if (parameter === 'language') return { kind: 'language' };
  return { kind: 'none' };
}
