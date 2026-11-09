import { readFile, stat } from 'node:fs/promises';
import { noteCandidates } from './inject';
import type { KnowledgeStore, NoteFile } from './store';

/**
 * The notes most likely to bear on one message, found by matching its words
 * against each note's name and body (BM25) — the index ranks notes by how much
 * they were read, never by what is being asked now.
 *
 * Kept out of the index on purpose: the index is versioned so that a
 * conversation already holding it gets a stub, and a part that changed with
 * every message would resend the whole block every time.
 */
export interface RelevantNotes {
  /** Where the notes live: note `x/y` is `<notesDir>/x/y.md`. */
  notesDir?: string;
  /** Best match first. */
  notes: string[];
}

export interface FindRelevantNotesInput {
  store: KnowledgeStore;
  scopeId: string;
  /** What is being asked: the message text (a scheduled job's prompt). */
  query: string;
  limit?: number;
  /** The owner's own private chat: `notes/global-owner/` may match too. */
  ownerPrivate?: boolean;
}

const DEFAULT_LIMIT = 8;
/** Below this a match is a word or two in common, not a topic in common. */
const MIN_SCORE = 6;
/** A match far weaker than the best one is noise next to it. */
const MIN_SHARE_OF_BEST = 0.35;
/** Words in a note's name or first heading say what it is about: counted this many times over. */
const TITLE_WEIGHT = 3;
const MAX_QUERY_CHARS = 4_000;
const K1 = 1.2;
const B = 0.75;

const ASCII_STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'not', 'but', 'you', 'can', 'all', 'any',
  'http', 'https', 'www', 'com', 'md', 'json', 'true', 'false', 'null', 'ok',
]);

/** Chinese pairs that are grammar, not topic: they match everywhere and say nothing. */
const CJK_STOP = new Set(
  (
    '一下 一个 一些 一直 一样 这个 那个 这些 那些 这样 那样 这里 那里 什么 为什 怎么 怎样 有没 没有 可以 帮我 帮忙 看下 看一 看看 ' +
    '我们 你们 他们 现在 还有 已经 是不 不是 就是 然后 如果 因为 所以 但是 以及 还是 或者 的话 之前 之后 时候 需要 应该 能不 不能 ' +
    '下这 个问 问题 是什 么样 了吗 好的 谢谢 收到 我的 你的 一般 其实 比较 非常 直接 下吧 下看 么回 回事 哪个 在哪 哪里 哪些 个平 这台 那台'
  ).split(' '),
);

export async function findRelevantNotes(input: FindRelevantNotesInput): Promise<RelevantNotes | undefined> {
  const query = [...new Set(terms(input.query.slice(0, MAX_QUERY_CHARS)))];
  if (query.length === 0) return undefined;
  const candidates = await noteCandidates(input.store, input.scopeId, { ownerPrivate: input.ownerPrivate });
  const notes = [...candidates.own, ...candidates.global, ...candidates.external];
  if (notes.length === 0) return undefined;
  const docs = (await Promise.all(notes.map(loadDoc))).filter((doc): doc is Doc => doc !== undefined);
  const best = rankDocs(docs, query).slice(0, input.limit ?? DEFAULT_LIMIT);
  if (best.length === 0) return undefined;
  const dir = commonDir(best.map((hit) => hit.note));
  return {
    ...(dir ? { notesDir: dir } : {}),
    notes: best.map((hit) => (dir ? hit.note.name : hit.note.path)),
  };
}

interface Doc {
  note: NoteFile;
  tf: Map<string, number>;
  length: number;
}

/** Notes scoring above the bar, best first. */
export function rankDocs(docs: readonly Doc[], query: readonly string[]): Array<{ note: NoteFile; score: number }> {
  if (docs.length === 0) return [];
  const avg = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const term of query) df.set(term, docs.filter((doc) => doc.tf.has(term)).length);
  const scored = docs
    .map((doc) => {
      let score = 0;
      for (const term of query) {
        const tf = doc.tf.get(term);
        if (!tf) continue;
        const n = df.get(term)!;
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
        score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avg));
      }
      return { note: doc.note, score };
    })
    .filter((hit) => hit.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  return scored.filter((hit) => hit.score >= top * MIN_SHARE_OF_BEST);
}

/** A note's term counts, title words weighted. */
export function docOf(note: NoteFile, body: string): Doc {
  const tf = new Map<string, number>();
  const add = (term: string, by: number) => tf.set(term, (tf.get(term) ?? 0) + by);
  const bodyTerms = terms(body);
  for (const term of bodyTerms) add(term, 1);
  const topic = note.name.slice(note.name.indexOf('/') + 1);
  const heading = /^#\s+(.+)$/m.exec(body)?.[1] ?? '';
  for (const term of new Set(terms(`${topic} ${heading}`))) add(term, TITLE_WEIGHT);
  return { note, tf, length: bodyTerms.length };
}

/**
 * Words to match on: Latin / digit tokens (and their parts, so `antelope:deploy`
 * also matches `deploy`) and Chinese character pairs — Chinese has no spaces,
 * and pairs catch most words without a dictionary.
 */
export function terms(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const token of lower.match(/[a-z0-9][a-z0-9_.:\-]*[a-z0-9]|[a-z0-9]/g) ?? []) {
    const parts = token.split(/[_.:\-]+/);
    for (const word of parts.length > 1 ? [token, ...parts] : [token]) {
      if (word.length < 2 || ASCII_STOP.has(word) || /^\d{1,2}$/.test(word)) continue;
      out.push(word);
    }
  }
  for (const run of lower.match(/[㐀-鿿]{2,}/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) {
      const pair = run.slice(i, i + 2);
      if (!CJK_STOP.has(pair)) out.push(pair);
    }
  }
  return out;
}

const cache = new Map<string, { mtimeMs: number; size: number; doc: Doc }>();

async function loadDoc(note: NoteFile): Promise<Doc | undefined> {
  try {
    const info = await stat(note.path);
    const hit = cache.get(note.path);
    if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size && hit.doc.note.name === note.name) return hit.doc;
    const doc = docOf(note, await readFile(note.path, 'utf8'));
    cache.set(note.path, { mtimeMs: info.mtimeMs, size: info.size, doc });
    return doc;
  } catch {
    return undefined;
  }
}

function commonDir(notes: readonly NoteFile[]): string | undefined {
  const first = notes[0];
  if (!first) return undefined;
  const suffix = `/${first.name}.md`;
  const dir = first.path.endsWith(suffix) ? first.path.slice(0, -suffix.length) : undefined;
  return dir && notes.every((note) => note.path === `${dir}/${note.name}.md`) ? dir : undefined;
}
