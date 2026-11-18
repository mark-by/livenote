import type { VaultProblem, VaultProblemCode } from '../shared/types.js';
import { DocumentProblem, fileVersion, materializeVaultDocument, openable, parseVaultSyntax, type ParsedVaultDocument } from './vaultDocument.js';
import { decodeVaultText, type FileWrite, type VaultFiles } from './vaultFiles.js';
import type { VaultFileRecord } from './vaultIndex.js';
import { buildLinkGraph, linkSpans, publicLinks } from './vaultLinks.js';
import { ignoredPath } from './vaultIgnore.js';

type FileFailure = { readonly code: VaultProblemCode; readonly message: string };
type Observation = VaultFileRecord | FileFailure;
type PageRecord = {
  readonly file: VaultFileRecord;
  readonly dependencies: readonly string[];
  readonly graphKey: string;
  readonly parsed: ParsedVaultDocument;
};

function fileFailure(error: unknown): FileFailure {
  if (error instanceof DocumentProblem) return { code: error.code, message: error.message };
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return { code: error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing_asset' : 'unreadable_file', message: error.message };
  }
  throw error;
}

function indexFile(path: string, stat: { readonly bytes: Buffer; readonly stamp: string; readonly mtimeMs: number; readonly birthtimeMs: number }): VaultFileRecord {
  const { bytes, ...metadata } = stat;
  const base = { ...metadata, version: fileVersion(bytes) };
  if (!openable(path)) return { ...base, text: { kind: 'binary' } };
  let source: string;
  try { source = decodeVaultText(bytes); }
  catch (error) {
    if (!(error instanceof DocumentProblem)) throw error;
    return { ...base, text: { kind: 'invalid' } };
  }
  try {
    const syntax = parseVaultSyntax(source, path);
    const links = linkSpans(source).map(link => ({ ...link, targetPageId: null }));
    return { ...base, text: { kind: 'document', source, syntax, links } };
  } catch (error) {
    if (!(error instanceof DocumentProblem) || error.code !== 'git_conflict') throw error;
    return { ...base, text: { kind: 'conflict', source } };
  }
}

function equal<T>(previous: readonly T[], next: readonly T[]): boolean {
  return previous.length === next.length && previous.every((value, index) => value === next[index]);
}

/** Проекция сопоставляет подтверждённые версии файлов с документами и графом. */
export class VaultProjection {
  private treeInputs: string[] = [];
  private paths: string[] = [];
  private entries = new Map<string, PageRecord>();
  private graph = buildLinkGraph([], [], new Map());
  treeVersion = '';

  constructor(private records: ReadonlyMap<string, VaultFileRecord>) {}

  reconcile(files: VaultFiles, deferred: readonly FileWrite[] | null) {
    const scan = files.list();
    const problems = [...scan.problems, ...files.recoveryProblems.filter(problem => !ignoredPath(scan.rules, problem.path, false))];
    const quarantined = new Map(files.recoveryProblems.map(problem => [problem.path, problem]));
    const observed = new Map<string, Observation>();
    const records = new Map<string, VaultFileRecord>();
    const observe = (path: string): Observation => {
      const known = observed.get(path);
      if (known) return known;
      let result: Observation;
      const quarantine = quarantined.get(path);
      if (quarantine) result = quarantine;
      else {
        try {
          const stamp = files.stamp(path);
          const old = this.records.get(path);
          result = old?.stamp === stamp ? old : indexFile(path, files.readBytes(path));
          records.set(path, result);
        } catch (error) { result = fileFailure(error); }
      }
      observed.set(path, result);
      return result;
    };

    const versions = scan.files.map(path => {
      const file = observe(path);
      if ('version' in file) return [path, file.version];
      if (!quarantined.has(path)) problems.push({ ...file, code: file.code === 'missing_asset' ? 'unreadable_file' : file.code, path, ...(openable(path) ? { pageId: path } : {}) });
      return [path, file.code === 'missing_asset' ? 'missing' : file.code];
    });
    const treeInputs = [...scan.folders, '\0', ...versions.flat()];
    if (!equal(this.treeInputs, treeInputs)) {
      this.treeVersion = fileVersion(JSON.stringify([scan.folders, versions]));
      this.treeInputs = treeInputs;
    }

    const staged = new Map<string, Observation>();
    const paths = new Set(scan.files);
    for (const write of deferred ?? []) {
      if (!openable(write.path) || write.path.startsWith('.livenote/') || ignoredPath(scan.rules, write.path, false)) continue;
      if (write.source === null) {
        paths.delete(write.path);
        staged.set(write.path, { code: 'missing_asset', message: 'Файл удалён' });
      } else {
        paths.add(write.path);
        staged.set(write.path, indexFile(write.path, { bytes: Buffer.from(write.source), stamp: '', mtimeMs: 0, birthtimeMs: 0 }));
      }
    }
    const nextPaths = [...paths].sort();
    const next = new Map<string, PageRecord>();
    let graphChanged = !equal(this.paths, nextPaths);
    for (const path of nextPaths) {
      if (!openable(path) || quarantined.has(path)) continue;
      const file = staged.get(path) ?? observe(path);
      if (!('text' in file)) continue;
      if (file.text.kind !== 'document') {
        problems.push(file.text.kind === 'conflict'
          ? { code: 'git_conflict', path, pageId: path, message: 'Обнаружен конфликт Git' }
          : { code: 'unreadable_file', path, pageId: path, message: 'Файл не является UTF-8' });
        continue;
      }
      const assets = new Map(file.text.syntax.spans.flatMap(span => span.assetPath ? [[span.assetPath, staged.get(span.assetPath) ?? observe(span.assetPath)] as const] : []));
      const dependencies = [...assets.values()].map(asset => 'stamp' in asset ? asset.stamp || asset.version : asset.code);
      const old = this.entries.get(path);
      if (old?.file === file && equal(old.dependencies, dependencies)) {
        next.set(path, old);
        problems.push(...old.parsed.problems);
        continue;
      }
      const parsed = materializeVaultDocument(file.text.source, path, file.text.syntax, assetPath => {
        const asset = assets.get(assetPath);
        if (asset && 'text' in asset && 'source' in asset.text) return { source: asset.text.source, mtimeMs: asset.mtimeMs, version: asset.version };
        throw new DocumentProblem(asset && 'code' in asset ? asset.code : 'unreadable_file', 'Файл диаграммы недоступен');
      }, file);
      const graphKey = old?.file === file ? old.graphKey : JSON.stringify([file.text.syntax.aliases, file.text.links]);
      graphChanged ||= old?.graphKey !== graphKey;
      next.set(path, { file, dependencies, graphKey, parsed });
      problems.push(...parsed.problems);
    }
    graphChanged ||= this.entries.size !== next.size;
    if (graphChanged) {
      const documents = [...next.values()].map(({ parsed }) => parsed.document);
      const spans = new Map([...next].flatMap(([path, { file }]) => file.text.kind === 'document' ? [[path, file.text.links] as const] : []));
      this.graph = buildLinkGraph(documents, nextPaths, spans);
    }
    for (const [path, entry] of next) {
      const old = this.entries.get(path);
      if (!graphChanged && old === entry) continue;
      const { parsed } = entry;
      const links = graphChanged ? publicLinks(this.graph.links.get(path) ?? []) : old?.parsed.document.links ?? [];
      const backlinks = this.graph.backlinks.get(path) ?? [];
      next.set(path, { ...entry, parsed: { ...parsed, document: { ...parsed.document, links, backlinks } } });
    }
    this.paths = nextPaths;
    this.entries = next;
    if (!deferred) this.records = records;
    const visibleRecords = new Map([...records].filter(([path]) => paths.has(path)));
    return { pages: new Map([...next].map(([path, { parsed }]) => [path, parsed])), problems, records: visibleRecords, folders: scan.folders, links: this.graph.links };
  }
}
