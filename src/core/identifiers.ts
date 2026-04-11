import { createHash } from 'node:crypto';

export function hashIdentifier(identifier: string): string {
  return createHash('sha256').update(identifier).digest('hex').slice(0, 16);
}

export function combineIdentifiers(...parts: string[]): string {
  return parts.filter(Boolean).join(':');
}
