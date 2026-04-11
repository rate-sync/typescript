import { describe, it, expect } from 'vitest';
import { getClientIp } from '../../../src/contrib/next/ip.js';

function makeReq(headers: Record<string, string | null>) {
  return {
    headers: {
      get(name: string): string | null {
        return headers[name] ?? null;
      },
    },
  };
}

describe('getClientIp', () => {
  it('extracts the first IP from x-forwarded-for when multiple IPs are present', () => {
    const req = makeReq({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.10.11.12' });
    expect(getClientIp(req)).toBe('1.2.3.4');
  });

  it('returns the single IP from x-forwarded-for when only one is present', () => {
    const req = makeReq({ 'x-forwarded-for': '203.0.113.5' });
    expect(getClientIp(req)).toBe('203.0.113.5');
  });

  it('trims whitespace from x-forwarded-for first IP', () => {
    const req = makeReq({ 'x-forwarded-for': '  10.0.0.1 , 10.0.0.2' });
    expect(getClientIp(req)).toBe('10.0.0.1');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const req = makeReq({ 'x-real-ip': '172.16.0.1' });
    expect(getClientIp(req)).toBe('172.16.0.1');
  });

  it('falls back to 127.0.0.1 when both headers are absent', () => {
    const req = makeReq({});
    expect(getClientIp(req)).toBe('127.0.0.1');
  });

  it('prefers x-forwarded-for over x-real-ip when both are present', () => {
    const req = makeReq({
      'x-forwarded-for': '8.8.8.8',
      'x-real-ip': '1.1.1.1',
    });
    expect(getClientIp(req)).toBe('8.8.8.8');
  });

  it('falls back to x-real-ip when x-forwarded-for is an empty string', () => {
    const req = makeReq({
      'x-forwarded-for': '',
      'x-real-ip': '10.0.0.5',
    });
    expect(getClientIp(req)).toBe('10.0.0.5');
  });
});
