// Extracting the constraints stated in a conversation.
//
// When the user says "don't push" or "don't deploy until I have seen it", that
// becomes a BLOCK SIGNAL for the classifier — even if the default rules would
// have allowed the action.
//
// Two important properties of Claude Code are reproduced here:
//   1) a constraint is not stored as a rule — it is re-read from the
//      conversation on every check (so it disappears once the old message
//      falls out of the context);
//   2) THE AGENT ITSELF cannot lift a constraint — its conclusion that "the
//      condition has been met" does not count, only a new message from the
//      user does.
//
// No LLM is used here: the constraints are added to the classifier prompt raw
// and the decision is left to the LLM itself. This module only answers the
// question "which messages look like a constraint?" — a crude but cheap
// filter.
//
// ---------------------------------------------------------------------------
// NOTE ON LANGUAGE DATA
// ---------------------------------------------------------------------------
// The word lists and regular expressions below are Uzbek-language DETECTION
// PATTERNS, not prose. They are the feature itself: they are what matches the
// user's actual wording. They are intentionally NOT translated — translating
// them would break detection. Only the surrounding comments are in English.
//
// ---------------------------------------------------------------------------
// WHY NOT "any word ending in -ma"
// ---------------------------------------------------------------------------
// This file used to carry the pattern `/\b\w+ma\b/i`: ANY word ending in "ma"
// was accepted as a constraint. Uzbek (and especially a conversation about
// programming) has a great many borrowed nouns ending in `-ma`, so the pattern
// wrongly matched things like:
//
//   sxema, tema, forma, sistema, problema, diagramma, norma, reklama,
//   dasturlama, juma, tizma
//
// That is, a completely ordinary request such as "sxema chizib ber" ("draw me
// a schema") or "bu forma komponentini tuzat" ("fix this form component")
// landed in the classifier prompt as "the user set a constraint". The harm is
// not just an extra sentence: the constraints section of the prompt comes with
// the instruction "BLOCK any action that violates these limits", so the LLM is
// pushed to treat that very sentence as a constraint and may end up blocking
// the requested work itself.
//
// The fix: not "does the word end in -ma", but "is this a VERB + a negation
// suffix". Two lists are used for that:
//   1) NEGATION_VERBS — verb stems that genuinely occur in a constraint sense
//      (qil, o'chir, teg, yubor, push qil, deploy qil ...);
//   2) NEGATION_SUFFIX — the full forms of the negative imperative
//      (-ma, -mang, -masin, -maslik, -may, -masdan ...).
//
// The list is deliberately closed: a false positive is costlier than a missed
// constraint (a false negative), because a missed constraint can still be seen
// by the classifier itself in the conversation text — the conversation reaches
// the prompt in full anyway. If a verb that is not in the list shows up, it is
// enough to add it here.

/**
 * Verb stems that, combined with a negation suffix, carry a constraint meaning.
 *
 * Multi-word entries ("push qil", "ishga tushir") are included too — in Uzbek
 * many English terms are formed with the auxiliary verb `qil`.
 *
 * Uzbek language data — kept verbatim on purpose (see the note above).
 */
const NEGATION_VERBS = [
  // general action
  'qil', 'et', 'bajar', 'ishlat', 'urin', 'harakat qil',
  // creating / changing
  'yoz', 'yarat', "qo'sh", "o'zgartir", 'tahrirla', 'tuzat', 'almashtir',
  "ko'chir", 'nusxala', 'formatla',
  // deleting
  "o'chir", 'tashla', 'tozala', "yo'q qil", 'olib tashla',
  // touching
  'teg',
  // sending outward
  'yubor', "jo'nat", 'chiqar', 'yukla', "o'rnat",
  'push qil', 'deploy qil', 'commit qil', 'merge qil', 'publish qil',
  // process control
  'ishga tushir', "to'xtat", 'qayta yukla', 'ulan', 'och', 'yop',
  // interaction / movement
  "so'ra", 'ber', 'ol', 'ket', 'bor', 'kir', 'chiq', 'boshla', 'davom ettir',
]

/**
 * The forms of the negative imperative.
 *
 * `-ma` (qilma), `-mang`/`-mangiz` (polite), `-masin` (third person),
 * `-maslik` (verbal noun: "o'chirmaslikni so'rayman"), `-may`/`-masdan`
 * (adverbial: "o'zgartirmasdan tekshir"), `-magin` (colloquial).
 *
 * Uzbek language data — kept verbatim on purpose.
 */
const NEGATION_SUFFIX = "(?:ma|mang|mangiz|manglar|masin|masinlar|masangiz|maslik|maslikni|may|masdan|magin)"

/** Escapes RegExp special characters — the verb list contains `'` */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The "VERB + negation" pattern.
 *
 * `[^\p{L}]` is used as the boundary instead of `\b`: the Uzbek apostrophes
 * (`'`, `'`) are not part of `\w`, so `\b` would split "o'chirma" in the wrong
 * place.
 */
const NEGATION_PATTERN = new RegExp(
  `(?:^|[^\\p{L}])(?:${NEGATION_VERBS.map(escapeRegExp).join('|')})${NEGATION_SUFFIX}(?![\\p{L}])`,
  'iu',
)

/**
 * Uzbek and English patterns that signal a constraint.
 *
 * The Uzbek literals below are language data — kept verbatim on purpose.
 */
const CONSTRAINT_PATTERNS: RegExp[] = [
  // Uzbek negation: verb + negation suffix (qilma, o'chirmang, tegmasin)
  NEGATION_PATTERN,
  // Other Uzbek constraint phrases ("not needed", "no need", "stop",
  // "refuse", "until I have seen", "ask me first", "only after", "without
  // permission")
  /kerak\s+emas/i,
  /shart\s+emas/i,
  /\bto['’]?xta/i,
  /\brad\s+et/i,
  /\bmen\s+ko['’]?r(gunim|maguncha)/i,
  /\bavval\s+(so['’]?ra|menga)/i,
  /\bfaqat\s+.*\bkeyin\b/i,
  /\bruxsatsiz\b/i,
  // English
  /\bdon['’]?t\b/i,
  /\bdo not\b/i,
  /\bnever\b/i,
  /\bavoid\b/i,
  /\bwait until\b/i,
  /\bbefore you\b/i,
  /\bask (me )?first\b/i,
  /\bwithout (my )?(permission|approval)\b/i,
]

/** Does a single message look like it is stating a constraint */
export function isConstraint(text: string): boolean {
  return CONSTRAINT_PATTERNS.some((p) => p.test(text))
}

/**
 * Picks out the USER messages in a conversation that state a constraint.
 *
 * Only the `user` role is taken: a message from the agent itself can neither
 * set a constraint nor lift one.
 */
export function extractConstraints(
  messages: { role: 'user' | 'assistant'; text: string }[],
): string[] {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => m.text.trim())
    .filter((t) => t.length > 0 && isConstraint(t))
}
