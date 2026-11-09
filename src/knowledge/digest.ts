/**
 * 全局知识整合层: 课堂精练's last step folds the raw notes of every chat
 * (`notes/<scope>/…`, appended to, never merged in place) into topic notes
 * of their own —
 *
 * - `notes/global/<topic>.md`: what every chat may be told;
 * - `notes/global-owner/<topic>.md`: what only the owner's private chat may
 *   (production hosts, people, the owner's own affairs);
 * - `notes/global-external/<topic>.md`: other bots' notes (`notes/external/`).
 *
 * `notes/global/_manifest.json` says which raw note each layer note stands
 * for. The index lists the layer instead of the raw notes it covers, and a
 * chat's "own" share is the layer topics its notes went into.
 *
 * Restricted chats (`access.restrictedChats`) are never folded in: their
 * notes stay theirs alone.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const GLOBAL_SCOPE = 'global';
export const GLOBAL_OWNER_SCOPE = 'global-owner';
export const GLOBAL_EXTERNAL_SCOPE = 'global-external';
export const DIGEST_SCOPES = [GLOBAL_SCOPE, GLOBAL_OWNER_SCOPE, GLOBAL_EXTERNAL_SCOPE] as const;
export type DigestScope = (typeof DIGEST_SCOPES)[number];
/** Relative to the knowledge directory. */
export const DIGEST_MANIFEST = 'notes/global/_manifest.json';

export interface DigestSource {
  /** sha256 (16 hex) of the raw note's content when it was folded in. */
  hash: string;
  /** Each entry id of the raw note → the layer note (`<layer>/<topic>`) it went into; null = dropped as a duplicate or stale. */
  entries: Record<string, string | null>;
}

export interface DigestManifest {
  version: 1;
  /** Last time the layer was rebuilt (epoch ms). */
  updatedAt: number;
  /** Raw note (`<scope>/<topic>`) → how it was folded in. */
  sources: Record<string, DigestSource>;
}

export function emptyManifest(): DigestManifest {
  return { version: 1, updatedAt: 0, sources: {} };
}

export function isDigestScope(scope: string): scope is DigestScope {
  return (DIGEST_SCOPES as readonly string[]).includes(scope);
}

/** A family (`oc_xxx`) of a scope directory (`oc_xxx` or `oc_xxx_omt_yyy`). */
export function familyOf(scope: string): string {
  const at = scope.indexOf('_omt_');
  return at < 0 ? scope : scope.slice(0, at);
}

export function parseManifest(raw: string | undefined): DigestManifest {
  if (!raw) return emptyManifest();
  try {
    const data = JSON.parse(raw) as Partial<DigestManifest>;
    if (!data || data.version !== 1 || typeof data.sources !== 'object' || data.sources === null) return emptyManifest();
    const sources: Record<string, DigestSource> = {};
    for (const [name, source] of Object.entries(data.sources)) {
      if (!source || typeof source.hash !== 'string' || typeof source.entries !== 'object' || source.entries === null) continue;
      sources[name] = { hash: source.hash, entries: { ...source.entries } };
    }
    return { version: 1, updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0, sources };
  } catch {
    return emptyManifest();
  }
}

/** What the index needs from the manifest. */
export interface DigestView {
  /** Raw notes folded into the layer: listed through it, not on their own. */
  covered: ReadonlySet<string>;
  /** Family (`oc_xxx`, or `external`) → the layer notes its raw notes went into. */
  topicsOf: (family: string) => ReadonlySet<string>;
  /** Raw notes folded into a layer note (`global/x`, or a part of it, `global/x-2`). */
  sourcesOf: (layerNote: string) => readonly string[];
}

export function digestView(manifest: DigestManifest): DigestView {
  const covered = new Set<string>();
  const byFamily = new Map<string, Set<string>>();
  const byTarget = new Map<string, Set<string>>();
  for (const [name, source] of Object.entries(manifest.sources)) {
    covered.add(name);
    for (const target of Object.values(source.entries)) {
      if (!target) continue;
      let names = byTarget.get(target);
      if (!names) byTarget.set(target, (names = new Set()));
      names.add(name);
    }
    const family = familyOf(name.split('/')[0] ?? '');
    let topics = byFamily.get(family);
    if (!topics) byFamily.set(family, (topics = new Set()));
    for (const target of Object.values(source.entries)) if (target) topics.add(target);
  }
  const none = new Set<string>();
  return {
    covered,
    topicsOf: (family) => byFamily.get(family) ?? none,
    sourcesOf: (layerNote) => [...(byTarget.get(layerNote.replace(/-\d+$/, '')) ?? none)],
  };
}

/**
 * Reads the manifest of a knowledge directory, once per change of the file:
 * the index is built on every message.
 */
export class DigestManifestReader {
  private cached: { mtimeMs: number; view: DigestView } | undefined;

  constructor(private readonly knowledgeDir: string) {}

  /** The view as last read, without touching the disk (undefined before the first read). */
  last(): DigestView | undefined {
    return this.cached?.view;
  }

  async view(): Promise<DigestView> {
    const path = join(this.knowledgeDir, DIGEST_MANIFEST);
    const info = await stat(path).catch(() => undefined);
    if (!info) {
      this.cached = undefined;
      return digestView(emptyManifest());
    }
    if (this.cached?.mtimeMs === info.mtimeMs) return this.cached.view;
    const view = digestView(parseManifest(await readFile(path, 'utf8').catch(() => undefined)));
    this.cached = { mtimeMs: info.mtimeMs, view };
    return view;
  }
}
