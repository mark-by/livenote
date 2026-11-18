import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function vaultIdForRoot(canonicalRoot: string): string {
  const digest = createHash('sha256').update('livenote:vault\0').update(canonicalRoot).digest('hex');
  const variant = ((Number.parseInt(digest.slice(16, 17), 16) & 3) | 8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function vaultCachePath(canonicalRoot: string, cacheHome = join(homedir(), '.livenote')): string {
  return join(cacheHome, vaultIdForRoot(canonicalRoot), 'index.sqlite');
}
