import { describe, expect, it } from 'vitest';

import {
  parseExactUntrustedBlock,
  parseSingleUntrustedBlock,
  wrapUntrustedContent,
} from './untrusted-content.js';

describe('untrusted-content parser', () => {
  it('parses an exact wrapped block', () => {
    expect(parseExactUntrustedBlock('<untrusted>hello</untrusted>')).toBe(
      'hello',
    );
  });

  it('parses a single block embedded in trusted text', () => {
    expect(
      parseSingleUntrustedBlock(
        'Forwarded email\n<untrusted>body</untrusted>\nTrusted suffix',
      ),
    ).toEqual({
      before: 'Forwarded email\n',
      content: 'body',
      after: '\nTrusted suffix',
    });
  });

  it('rejects text without an opening marker', () => {
    expect(() => parseExactUntrustedBlock('hello')).toThrow(
      'missing opening untrusted marker',
    );
  });

  it('rejects text without a closing marker', () => {
    expect(() => parseExactUntrustedBlock('<untrusted>hello')).toThrow(
      'missing closing untrusted marker',
    );
  });

  it('rejects duplicate opening markers', () => {
    expect(() =>
      parseSingleUntrustedBlock(
        '<untrusted>hello<untrusted>nested</untrusted>',
      ),
    ).toThrow('multiple opening untrusted markers are not allowed');
  });

  it('rejects duplicate closing markers', () => {
    expect(() =>
      parseSingleUntrustedBlock('<untrusted>hello</untrusted></untrusted>'),
    ).toThrow('multiple closing untrusted markers are not allowed');
  });

  it('wraps content with the expected tags', () => {
    expect(wrapUntrustedContent('hello')).toBe('<untrusted>hello</untrusted>');
  });
});
