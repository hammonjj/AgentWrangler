/**
 * Does an agent's final message need an answer from the human?
 *
 * This is what separates "Waiting" from "Done". Nothing in Claude Code
 * marks the difference — a turn that ends with "which option?" and one that
 * ends with "all tests pass, nothing committed" both arrive as a plain `Stop`.
 * The only evidence is the text, so this is a heuristic and errs towards
 * `true`: a report wrongly filed under Waiting costs a glance, a question
 * wrongly filed under Done costs an agent sitting idle until someone notices.
 *
 * Pure, dependency-free: used by the Claude provider today and by any future
 * provider whose turn end carries the reply.
 */

/**
 * Phrases that ask for a decision without a question mark. Matched against the
 * tail of the message only, where a closing ask sits.
 */
const ASK_PHRASES =
  /\b(let me know|which (one|option|approach|do you|would you)|would you (like|prefer|rather)|do you want|should i\b|shall i\b|want me to|your call|up to you|please (confirm|choose|pick|decide|advise)|awaiting your|waiting (for|on) (you|your)|before i (proceed|continue|go ahead)|tell me (which|whether|if)|say (which|the word)|reply (with|"|“))/i;

/** A line that ends in a question mark, allowing trailing markdown/quote characters. */
const QUESTION_LINE = /\?[\s*_`)"'”’\]]*$/m;

/**
 * Strip parts that carry question marks without asking the reader anything:
 * fenced code, inline code, and URLs (query strings).
 */
function stripNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
}

/**
 * True when the message reads as a question or a request for a decision, and
 * for an empty/unknown message, where assuming the human is needed is the safe
 * default. Only the last two paragraphs are examined: a rhetorical "why did
 * this fail?" in the middle of a report is exposition, not a request.
 */
export function needsReply(text: string | undefined): boolean {
  if (text === undefined) return true;
  const clean = stripNoise(text).trim();
  if (clean.length === 0) return true;

  const paragraphs = clean
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const tail = paragraphs.slice(-2).join('\n');

  return QUESTION_LINE.test(tail) || ASK_PHRASES.test(tail);
}
