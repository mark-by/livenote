import { useCallback, useEffect, useState } from 'react';

function readExpandedFolders(key: string): ReadonlySet<string> {
  try {
    const paths: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return new Set(Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : []);
  } catch {
    return new Set();
  }
}

export function useVaultFolderExpansion(vaultId: string | null) {
  const key = `livenote_expanded_folders:${vaultId === null ? '' : encodeURIComponent(vaultId)}`;
  const [expandedFolders, setExpandedFolders] = useState(() => readExpandedFolders(key));

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify([...expandedFolders]));
  }, [key, expandedFolders]);

  const setFoldersExpanded = useCallback((paths: readonly string[], expanded: boolean): void => {
    setExpandedFolders(current => {
      if (paths.every(path => current.has(path) === expanded)) return current;
      const next = new Set(current);
      for (const path of paths) {
        if (expanded) next.add(path);
        else next.delete(path);
      }
      return next;
    });
  }, []);

  return { expandedFolders, setFoldersExpanded };
}
