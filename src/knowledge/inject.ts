import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { nativeSkillDirsFor } from '../agent/native-skills';
import type { AgentKind } from '../agent/registry';
import { digestView, emptyManifest, familyOf, GLOBAL_EXTERNAL_SCOPE, GLOBAL_OWNER_SCOPE, GLOBAL_SCOPE, isDigestScope } from './digest';
import { sanitizeScopeId, type KnowledgeStore, type MemoryEntry, type NoteFile, type SkillSummary } from './store';

export interface KnowledgeContext {
  /**
   * Hash of everything below. A resumed conversation that still holds the
   * block of this version gets a short stub instead (see {@link knowledgeStub}).
   */
  version?: string;
  /** Notes that apply to every chat in this profile. */
  profileMemory?: string[];
  /** Notes recorded for this chat / topic only. */
  chatMemory?: string[];
  /** Index only — the agent reads a skill's body itself when it needs it. */
  skills?: SkillRef[];
  /** Where the notes live: note `x/y` is `<notesDir>/x/y.md`. */
  notesDir?: string;
  /** Topic notes (课堂精练), names only: `external/…` came from other bots' libraries. */
  notes?: string[];
  /** Set when notes were dropped to stay inside the budget. */
  truncated?: boolean;
}

export interface BuildKnowledgeContextInput {
  store: KnowledgeStore;
  scopeId: string;
  /** Character budget for the memory notes. Skills are just an index. */
  maxChars?: number;
  /**
   * Skill directory names the agent CLI already lists on its own (Claude
   * Code's `~/.claude/skills`): left out of the index rather than listed twice.
   */
  nativeSkillDirs?: ReadonlySet<string>;
  /**
   * The owner's own private chat: the only one that is shown
   * `notes/global-owner/` (production hosts, people, the owner's affairs).
   */
  ownerPrivate?: boolean;
}

export interface SkillRef {
  name: string;
  description: string;
  path: string;
  /** Shared library the skill comes from; absent for the profile's own. */
  source?: string;
}

/**
 * Memory budget. Notes past it are dropped oldest first — the oldest are often
 * the standing rules — so it sits above what the profile actually keeps; the
 * block now rides once per conversation, not on every message.
 */
const DEFAULT_MAX_CHARS = 10_000;
const MAX_SKILLS = 80;
/**
 * The index rides along on every message, and shared libraries can bring dozens
 * of skills with paragraph-long descriptions. One sentence is enough to decide
 * whether to open the body, and the whole index gets its own budget.
 */
const MAX_DESCRIPTION_CHARS = 240;
const SKILL_INDEX_MAX_CHARS = 16_000;
/** 课前学习 writes what it learned from other bots under `notes/external/`; every chat may read it. */
const EXTERNAL_NOTES_SCOPE = 'external';
/**
 * The notes index has four shares (主人 2026-11-05):
 * - global: the 全局知识整合层 (`notes/global/`, and `notes/global-owner/` in
 *   the owner's private chat), the most read of the last 30 days first;
 * - external: other bots' knowledge — `notes/global-external/` and whatever of
 *   `notes/external/` is not folded in yet — the most read first;
 * - own: this chat's raw notes not folded in yet (the newest knowledge), then
 *   the layer topics this chat's notes went into;
 * - refresh: the least shown of everything listable
 *   ({@link KnowledgeStore.noteExposures}), newest first among equals, so a
 *   note gone quiet comes round again.
 * Raw notes the layer covers are listed through it, never on their own. A
 * share with fewer notes than its slots leaves them to the others.
 */
const NOTE_SHARES = { global: 40, external: 30, own: 30, refresh: 20 } as const;
const MAX_NOTES = Object.values(NOTE_SHARES).reduce((sum, slots) => sum + slots, 0);

/**
 * Assemble what the agent should know before answering, or `undefined` when
 * there is nothing to inject.
 *
 * Only the skill *index* goes into the prompt. Bodies stay on disk and are read
 * on demand: a dozen skills would otherwise cost thousands of tokens on every
 * single turn, most of them irrelevant to the message at hand.
 */
export async function buildKnowledgeContext(
  input: BuildKnowledgeContextInput,
): Promise<KnowledgeContext | undefined> {
  // A topic (`oc_xxx:omt_yyy`) also sees its group's memory (`oc_xxx`), so a
  // topic group can keep one shared memory instead of one per topic.
  const groupId = input.scopeId.includes(':') ? input.scopeId.split(':')[0] : undefined;
  const [profile, group, topic, skills, candidates] = await Promise.all([
    input.store.listMemories({ kind: 'profile' }),
    groupId ? input.store.listMemories({ kind: 'chat', scopeId: groupId }) : Promise.resolve([]),
    input.store.listMemories({ kind: 'chat', scopeId: input.scopeId }),
    input.store.listSkills(),
    noteCandidates(input.store, input.scopeId, { ownerPrivate: input.ownerPrivate }),
  ]);
  // The notes read most lately first (课堂精练's recall counts); ties keep this topic's, the chat's, then other topics' order.
  const globalNotes = input.store.rankNotes(candidates.global);
  const externalNotes = input.store.rankNotes(candidates.external);
  const ownNotes = [...input.store.rankNotes(candidates.own), ...input.store.rankNotes(candidates.concerned)];
  const notes = [...new Set([...ownNotes, ...globalNotes, ...externalNotes])];
  const shown = input.store.noteExposures?.() ?? (() => 0);
  const createdAt = input.store.noteCreatedAt?.() ?? ((note: { createdAt?: number }) => note.createdAt);
  const born = new Map(notes.map((note) => [note, createdAt(note) ?? 0]));
  const refresh = [...notes].sort((a, b) => shown(a.name) - shown(b.name) || born.get(b)! - born.get(a)!);
  // A layer topic split into parts (`x`, `x-2`, …) takes one slot: picked together, listed together.
  const partsOf = topicGroups(notes);
  const groups = (list: NoteFile[]) => [...new Set(list.map((note) => partsOf.get(note)!))];
  const keptNotes = pickNotes({
    own: groups(ownNotes),
    global: groups(globalNotes),
    external: groups(externalNotes),
    refresh: groups(refresh),
  }).flat();
  const chat = [...group, ...topic];

  const budgeted = applyBudget(profile, chat, input.maxChars ?? DEFAULT_MAX_CHARS);
  const native = input.nativeSkillDirs;
  const ownSkills = native?.size ? skills.filter((skill) => !native.has(basename(dirname(skill.path)))) : skills;
  const trimmedSkills = budgetSkills(ownSkills.slice(0, MAX_SKILLS).map(toSkillRef));
  if (
    budgeted.profile.length === 0 &&
    budgeted.chat.length === 0 &&
    trimmedSkills.length === 0 &&
    keptNotes.length === 0
  ) {
    return undefined;
  }

  const body: KnowledgeContext = {
    ...(budgeted.profile.length > 0 ? { profileMemory: budgeted.profile } : {}),
    ...(budgeted.chat.length > 0 ? { chatMemory: budgeted.chat } : {}),
    ...(trimmedSkills.length > 0 ? { skills: trimmedSkills } : {}),
    ...notesIndex(keptNotes),
    ...(budgeted.truncated || ownSkills.length > trimmedSkills.length || notes.length > keptNotes.length ? { truncated: true } : {}),
  };
  return { version: knowledgeVersion(body), ...body };
}

/** `buildKnowledgeContext`'s `nativeSkillDirs` for an agent kind (none when it lists no skills). */
export function nativeSkillOption(kind: AgentKind): { nativeSkillDirs?: ReadonlySet<string> } {
  const dirs = nativeSkillDirsFor(kind);
  return dirs?.size ? { nativeSkillDirs: dirs } : {};
}

export interface NoteCandidates {
  /** The layer every chat sees (`global/`), and `global-owner/` in the owner's private chat. */
  global: NoteFile[];
  /** `global-external/`, then the `external/` notes not folded in yet. */
  external: NoteFile[];
  /** This chat's raw notes not folded in yet: this topic's, the chat's, then the chat's other topics'. */
  own: NoteFile[];
  /** The layer notes (among {@link global}) this chat's notes went into. */
  concerned: NoteFile[];
}

/**
 * The notes a chat may be shown: the 全局知识整合层, other bots' knowledge,
 * and its own raw notes (this topic's, the chat's, then the chat's other
 * topics', in that order) the layer does not cover yet.
 */
export async function noteCandidates(
  store: KnowledgeStore,
  scopeId: string,
  options: { ownerPrivate?: boolean } = {},
): Promise<NoteCandidates> {
  // A topic (`oc_xxx:omt_yyy`) also sees its group's notes, and every topic of the chat.
  const groupId = scopeId.includes(':') ? scopeId.split(':')[0] : undefined;
  const siblings = await store.noteTopicScopes(groupId ?? scopeId).catch(() => []);
  const listNotes = (scopes: string[]) => store.listNotes(scopes).catch(() => []);
  const [scopeNotes, groupNotes, siblingNotes, external, layer, layerExternal, digest] = await Promise.all([
    listNotes([scopeId]),
    groupId ? listNotes([groupId]) : Promise.resolve([]),
    listNotes(siblings.filter((scope) => scope !== sanitizeScopeId(scopeId))),
    listNotes([EXTERNAL_NOTES_SCOPE]),
    listNotes(options.ownerPrivate ? [GLOBAL_SCOPE, GLOBAL_OWNER_SCOPE] : [GLOBAL_SCOPE]),
    listNotes([GLOBAL_EXTERNAL_SCOPE]),
    (store.digestView?.() ?? Promise.resolve(digestView(emptyManifest()))).catch(() => digestView(emptyManifest())),
  ]);
  const fresh = (notes: NoteFile[]) => notes.filter((note) => !digest.covered.has(note.name));
  const topics = digest.topicsOf(familyOf(sanitizeScopeId(groupId ?? scopeId)));
  return {
    global: layer,
    external: [...layerExternal, ...fresh(external)],
    own: fresh([...scopeNotes, ...groupNotes, ...siblingNotes]),
    concerned: layer.filter((note) => topics.has(note.name)),
  };
}

/** Names of the notes a block lists (`<scope>/<topic>`), whether it lists them by name or by path. */
export function listedNoteNames(ctx: Pick<KnowledgeContext, 'notesDir' | 'notes'>): string[] {
  const notes = ctx.notes ?? [];
  if (ctx.notesDir) return [...notes];
  return notes.map((path) => /([^/]+\/[^/]+)\.md$/.exec(path)?.[1] ?? path);
}

/** Stable short hash of a knowledge block's content. */
export function knowledgeVersion(body: Omit<KnowledgeContext, 'version'>): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
}

/**
 * What a resumed conversation gets instead of the block when it still holds
 * this version in full (after its last compaction): the version it should
 * look back to, and a file with the same content in case it cannot find it.
 */
export function knowledgeStub(version: string, snapshot?: string): { unchangedSince: string; snapshot?: string } {
  return { unchangedSince: version, ...(snapshot ? { snapshot } : {}) };
}

/**
 * Each note → the parts of its layer topic (`global/x`, `global/x-2`, …, in
 * that order), one shared array per topic; a raw note is a topic of its own.
 */
export function topicGroups(notes: readonly NoteFile[]): Map<NoteFile, NoteFile[]> {
  const byTopic = new Map<string, NoteFile[]>();
  const out = new Map<NoteFile, NoteFile[]>();
  const part = (name: string) => Number(/-(\d+)$/.exec(name)?.[1] ?? 1);
  for (const note of notes) {
    const scope = note.name.split('/')[0] ?? '';
    const key = isDigestScope(scope) ? note.name.replace(/-\d+$/, '') : `\0${note.name}`;
    let parts = byTopic.get(key);
    if (!parts) byTopic.set(key, (parts = []));
    if (!parts.includes(note)) parts.push(note);
    out.set(note, parts);
  }
  for (const parts of byTopic.values()) parts.sort((a, b) => part(a.name) - part(b.name));
  return out;
}

export type NoteShares<T> ={ [share in keyof typeof NOTE_SHARES]?: readonly T[] };

/**
 * The notes that make the index, {@link MAX_NOTES} at most: each share's
 * first {@link NOTE_SHARES} slots (a note in two lists is taken once), then
 * the slots left go round the shares in turn.
 */
export function pickNotes<T>(lists: NoteShares<T>): T[] {
  const order = ['own', 'global', 'external', 'refresh'] as const;
  const taken = new Set<T>();
  const shares = new Map(order.map((share) => [share, 0]));
  const queues = new Map(order.map((share) => [share, [...(lists[share] ?? [])]]));
  const take = (share: (typeof order)[number]): boolean => {
    const queue = queues.get(share)!;
    while (queue.length > 0) {
      const note = queue.shift()!;
      if (taken.has(note)) continue;
      taken.add(note);
      shares.set(share, shares.get(share)! + 1);
      return true;
    }
    return false;
  };
  // Least shown first: such a note that is also among the most read leaves its own share a slot for the next one.
  for (const share of ['refresh', 'own', 'global', 'external'] as const) {
    while (shares.get(share)! < NOTE_SHARES[share] && take(share));
  }
  let room = MAX_NOTES - taken.size;
  while (room > 0) {
    let any = false;
    for (const share of order) {
      if (room > 0 && take(share)) {
        room--;
        any = true;
      }
    }
    if (!any) break;
  }
  // Listed own, global, then external, each most read first, whichever share took them: when everything fits, the order still means something.
  const listed = new Set([...(lists.own ?? []), ...(lists.global ?? []), ...(lists.external ?? []), ...(lists.refresh ?? [])]);
  return [...listed].filter((note) => taken.has(note));
}

/**
 * Notes as names under one directory instead of one absolute path each. The
 * store always lays them out that way; should one ever not fit, every note is
 * listed by its full path instead.
 */
function notesIndex(notes: Array<{ name: string; path: string }>): Pick<KnowledgeContext, 'notesDir' | 'notes'> {
  if (notes.length === 0) return {};
  const first = notes[0]!;
  const suffix = `/${first.name}.md`;
  const dir = first.path.endsWith(suffix) ? first.path.slice(0, -suffix.length) : undefined;
  if (dir && notes.every((note) => note.path === `${dir}/${note.name}.md`)) {
    return { notesDir: dir, notes: notes.map((note) => note.name) };
  }
  return { notes: notes.map((note) => note.path) };
}

function toSkillRef(skill: SkillSummary): SkillRef {
  const description =
    skill.description.length > MAX_DESCRIPTION_CHARS
      ? `${skill.description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
      : skill.description;
  return {
    name: skill.name,
    description,
    path: skill.path,
    ...(skill.source ? { source: skill.source } : {}),
  };
}

/** Keep skills in order until the index budget runs out (own skills come first). */
function budgetSkills(skills: SkillRef[]): SkillRef[] {
  const kept: SkillRef[] = [];
  let used = 0;
  for (const skill of skills) {
    const size = skill.name.length + skill.description.length + skill.path.length + (skill.source?.length ?? 0);
    if (used + size > SKILL_INDEX_MAX_CHARS) break;
    kept.push(skill);
    used += size;
  }
  return kept;
}

/**
 * Keep the newest notes when the budget is tight, and give chat notes priority
 * over profile ones: the local context is what the current message is about.
 */
function applyBudget(
  profile: MemoryEntry[],
  chat: MemoryEntry[],
  maxChars: number,
): { profile: string[]; chat: string[]; truncated: boolean } {
  const keptChat: string[] = [];
  const keptProfile: string[] = [];
  let used = 0;
  let truncated = false;

  for (const entry of [...chat].reverse()) {
    if (used + entry.text.length > maxChars) {
      truncated = true;
      break;
    }
    keptChat.unshift(entry.text);
    used += entry.text.length;
  }
  for (const entry of [...profile].reverse()) {
    if (used + entry.text.length > maxChars) {
      truncated = true;
      break;
    }
    keptProfile.unshift(entry.text);
    used += entry.text.length;
  }

  return { profile: keptProfile, chat: keptChat, truncated };
}
