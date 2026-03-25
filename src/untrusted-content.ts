export const UNTRUSTED_OPEN_TAG = '<untrusted>';
export const UNTRUSTED_CLOSE_TAG = '</untrusted>';

export interface UntrustedBlock {
  before: string;
  content: string;
  after: string;
}

function ensureSingleOccurrence(
  text: string,
  token: string,
  startAt: number,
  errorMessage: string,
): void {
  if (text.indexOf(token, startAt) !== -1) {
    throw new Error(errorMessage);
  }
}

export function parseExactUntrustedBlock(text: string): string {
  const parsed = parseSingleUntrustedBlock(text);
  if (parsed.before || parsed.after) {
    throw new Error('untrusted block must occupy the entire field');
  }
  return parsed.content;
}

export function parseSingleUntrustedBlock(text: string): UntrustedBlock {
  const openIndex = text.indexOf(UNTRUSTED_OPEN_TAG);
  const closeIndex = text.indexOf(UNTRUSTED_CLOSE_TAG);

  if (openIndex === -1) {
    throw new Error('missing opening untrusted marker');
  }
  if (closeIndex === -1) {
    throw new Error('missing closing untrusted marker');
  }
  if (closeIndex < openIndex) {
    throw new Error('closing untrusted marker appears before opening marker');
  }

  const contentStart = openIndex + UNTRUSTED_OPEN_TAG.length;
  const contentEnd = text.indexOf(UNTRUSTED_CLOSE_TAG, contentStart);
  if (contentEnd === -1) {
    throw new Error('missing closing untrusted marker');
  }

  ensureSingleOccurrence(
    text,
    UNTRUSTED_OPEN_TAG,
    contentStart,
    'multiple opening untrusted markers are not allowed',
  );
  ensureSingleOccurrence(
    text,
    UNTRUSTED_CLOSE_TAG,
    contentEnd + UNTRUSTED_CLOSE_TAG.length,
    'multiple closing untrusted markers are not allowed',
  );

  return {
    before: text.slice(0, openIndex),
    content: text.slice(contentStart, contentEnd),
    after: text.slice(contentEnd + UNTRUSTED_CLOSE_TAG.length),
  };
}

export function tryParseSingleUntrustedBlock(
  text: string,
): UntrustedBlock | null {
  try {
    return parseSingleUntrustedBlock(text);
  } catch {
    return null;
  }
}

export function wrapUntrustedContent(text: string): string {
  return `${UNTRUSTED_OPEN_TAG}${text}${UNTRUSTED_CLOSE_TAG}`;
}
