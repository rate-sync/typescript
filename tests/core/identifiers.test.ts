import { describe, it, expect } from 'vitest';
import { hashIdentifier, combineIdentifiers } from '../../src/core/identifiers';

describe('hashIdentifier', () => {
  it('returns 16-char hex string', () => {
    const h = hashIdentifier('test');
    expect(h).toHaveLength(16);
    expect(h).toMatch(/^[a-f0-9]+$/);
  });

  it('is deterministic', () => {
    expect(hashIdentifier('abc')).toBe(hashIdentifier('abc'));
  });

  it('differs for different inputs', () => {
    expect(hashIdentifier('a')).not.toBe(hashIdentifier('b'));
  });
});

describe('combineIdentifiers', () => {
  it('joins with colon', () => {
    expect(combineIdentifiers('api', 'user', '123')).toBe('api:user:123');
  });

  it('filters empty strings', () => {
    expect(combineIdentifiers('api', '', '123')).toBe('api:123');
  });

  it('preserves "0" (falsy string must NOT be dropped)', () => {
    expect(combineIdentifiers('api', '0', 'user')).toBe('api:0:user');
  });

  it('preserves single "0" argument', () => {
    expect(combineIdentifiers('0')).toBe('0');
  });
});
