export const ignoreFile = '.livenoteignore';

export function parseIgnoredDirectories(source: string): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const line of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const rule = line.trim();
    if (!rule || rule.startsWith('#')) continue;
    const path = rule.replace(/^\/|\/$/g, '').normalize('NFC');
    if (/[\0\\]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) continue;
    paths.add(path);
  }
  return paths;
}

export function ignoredPath(rules: ReadonlySet<string>, path: string, directory: boolean): boolean {
  const parts = path.normalize('NFC').split('/');
  if (!directory) parts.pop();
  let prefix = '';
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    if (rules.has(prefix)) return true;
  }
  return false;
}
