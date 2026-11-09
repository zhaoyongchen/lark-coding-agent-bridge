import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeSessionHasKnowledge } from '../../../src/agent/claude/session-probe.js';
import { promptSection } from '../../../src/agent/prompt.js';
import { buildKnowledgeContext, knowledgeStub, listedNoteNames, pickNotes } from '../../../src/knowledge/inject.js';
import type { KnowledgeStore } from '../../../src/knowledge/store.js';
import { digestView, type DigestManifest } from '../../../src/knowledge/digest.js';

const NOTES = '/kb/notes';

function fakeStore(
  over: {
    skills?: Array<{ name: string; path: string }>;
    profile?: string[];
    notes?: Record<string, string[]>;
    rank?: Record<string, number>;
    created?: Record<string, number>;
    shown?: Record<string, number>;
    manifest?: DigestManifest;
  } = {},
): KnowledgeStore {
  return {
    ...(over.manifest ? { digestView: async () => digestView(over.manifest!) } : {}),
    listMemories: async (scope: { kind: string }) =>
      scope.kind === 'profile' ? (over.profile ?? ['用中文回复']).map((text, i) => ({ id: `m${i}`, text })) : [],
    listSkills: async () =>
      (over.skills ?? [
        { name: 'occam:coffee', path: '/lib/occam-skills/skills/occam-coffee/SKILL.md' },
        { name: 'antelope:tcpdump', path: '/lib/occam-skills/skills/antelope-tcpdump/SKILL.md' },
      ]).map((s) => ({ ...s, description: `${s.name} 的说明` })),
    rankNotes: <T extends { name: string }>(notes: T[], order: 'desc' | 'asc' = 'desc') =>
      over.rank
        ? [...notes].sort((a, b) => (order === 'asc' ? -1 : 1) * ((over.rank![b.name] ?? 0) - (over.rank![a.name] ?? 0)))
        : [...notes],
    noteExposures: () => (name: string) => over.shown?.[name] ?? 0,
    noteTopicScopes: async (chatId: string) =>
      Object.keys(over.notes ?? {})
        .filter((scope) => scope.startsWith(`${chatId}_omt_`))
        .sort(),
    listNotes: async (scopes: string[]) =>
      [...new Set(scopes.map((scope) => scope.replace(/[^\w.-]+/g, '_')))].flatMap((scope) =>
        (over.notes?.[scope] ?? (scope === 'external' ? ['feishu-card', 'au-timezone'] : [])).map((topic) => ({
          name: `${scope}/${topic}`,
          path: `${NOTES}/${scope}/${topic}.md`,
          ...(over.created?.[`${scope}/${topic}`] !== undefined ? { createdAt: over.created[`${scope}/${topic}`] } : {}),
        })),
      ),
  } as unknown as KnowledgeStore;
}

describe('buildKnowledgeContext', () => {
  it('versions the block by its content, so an unchanged block keeps its version', async () => {
    const a = await buildKnowledgeContext({ store: fakeStore(), scopeId: 'oc_1' });
    const b = await buildKnowledgeContext({ store: fakeStore(), scopeId: 'oc_1' });
    const c = await buildKnowledgeContext({ store: fakeStore({ profile: ['用中文回复', '新记忆'] }), scopeId: 'oc_1' });
    expect(a?.version).toMatch(/^[0-9a-f]{16}$/);
    expect(b?.version).toBe(a?.version);
    expect(c?.version).not.toBe(a?.version);
  });

  it('lists notes by name under one directory instead of one absolute path each', async () => {
    const ctx = await buildKnowledgeContext({ store: fakeStore(), scopeId: 'oc_1' });
    expect(ctx?.notesDir).toBe(NOTES);
    expect(ctx?.notes).toEqual(['external/feishu-card', 'external/au-timezone']);
  });

  it("lists this chat's own notes before other bots' and keeps them in the index", async () => {
    const many = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(2, '0')}`);
    const ctx = await buildKnowledgeContext({
      store: fakeStore({ notes: { external: many('ext', 65), oc_1: many('group', 3), oc_1_omt_2: many('topic', 2) } }),
      scopeId: 'oc_1:omt_2',
    });
    expect(ctx?.notes?.slice(0, 5)).toEqual(['oc_1_omt_2/topic-00', 'oc_1_omt_2/topic-01', 'oc_1/group-00', 'oc_1/group-01', 'oc_1/group-02']);
    expect(ctx?.notes).toHaveLength(70);
    expect(ctx?.truncated).toBeUndefined();
    const more = await buildKnowledgeContext({
      store: fakeStore({ notes: { external: many('ext', 100), oc_1: many('group', 30), oc_1_omt_2: many('topic', 2) } }),
      scopeId: 'oc_1:omt_2',
    });
    expect(more?.notes).toHaveLength(120);
    expect(more?.notes?.filter((name) => name.startsWith('external/'))).toHaveLength(88);
    expect(more?.truncated).toBe(true);
  });

  it("lists the chat's other topics' notes after this topic's and the chat's own", async () => {
    const store = fakeStore({ notes: { oc_1: ['group'], oc_1_omt_1: ['first'], oc_1_omt_2: ['mine'], oc_1_omt_3: ['third'], oc_9_omt_1: ['other-chat'] } });
    const topic = await buildKnowledgeContext({ store, scopeId: 'oc_1:omt_2' });
    expect(topic?.notes).toEqual([
      'oc_1_omt_2/mine',
      'oc_1/group',
      'oc_1_omt_1/first',
      'oc_1_omt_3/third',
      'external/feishu-card',
      'external/au-timezone',
    ]);
    const chat = await buildKnowledgeContext({ store, scopeId: 'oc_1' });
    expect(chat?.notes?.slice(0, 4)).toEqual(['oc_1/group', 'oc_1_omt_1/first', 'oc_1_omt_2/mine', 'oc_1_omt_3/third']);
  });

  it('orders own and external notes by how often they were read, ties keeping their order', async () => {
    const store = fakeStore({
      notes: { oc_1: ['a', 'b'], oc_1_omt_1: ['x'], oc_1_omt_2: ['y'], external: ['e1', 'e2', 'e3'] },
      rank: { 'oc_1/b': 3, 'oc_1_omt_2/y': 5, 'external/e3': 9, 'external/e2': 1 },
    });
    const ctx = await buildKnowledgeContext({ store, scopeId: 'oc_1' });
    expect(ctx?.notes).toEqual(['oc_1_omt_2/y', 'oc_1/b', 'oc_1/a', 'oc_1_omt_1/x', 'external/e3', 'external/e2', 'external/e1']);
  });

  it('keeps a refresh share for the least shown notes, newest first among equals, read or not', async () => {
    const many = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(2, '0')}`);
    const store = fakeStore({
      notes: { oc_1: [...many('old', 70), 'fresh-a', 'fresh-b'], external: [...many('ext', 70), 'fresh-c'] },
      rank: Object.fromEntries([
        ...many('old', 70).map((topic, i) => [`oc_1/${topic}`, 100 - i]),
        ...many('ext', 70).map((topic, i) => [`external/${topic}`, 100 - i]),
      ]),
      // Shown often: the most read, and old-40..old-59 / ext-40..ext-59, which had their turn.
      shown: Object.fromEntries(
        [...many('old', 60).map((topic) => `oc_1/${topic}`), ...many('ext', 60).map((topic) => `external/${topic}`)].map((name) => [name, 5]),
      ),
      created: { 'oc_1/fresh-a': 3_000, 'oc_1/fresh-b': 1_000, 'external/fresh-c': 2_000 },
    });
    const ctx = await buildKnowledgeContext({ store, scopeId: 'oc_1' });
    expect(ctx?.notes).toHaveLength(120);
    expect(ctx?.notes?.slice(0, 2)).toEqual(['oc_1/old-00', 'oc_1/old-01']);
    // Never shown, unread: in, ahead of the most read beyond the first 40.
    expect(ctx?.notes).toEqual(expect.arrayContaining(['oc_1/fresh-a', 'oc_1/fresh-b', 'external/fresh-c', 'oc_1/old-69', 'external/ext-69']));
    expect(ctx?.notes).not.toContain('external/ext-45');
  });

  it('gives global 40, external 30, own 30 and refresh 20 slots, and lets the others fill a share that runs short', () => {
    const own = Array.from({ length: 70 }, (_, i) => `own-${i}`);
    const global = Array.from({ length: 70 }, (_, i) => `glob-${i}`);
    const external = Array.from({ length: 65 }, (_, i) => `ext-${i}`);
    const all = pickNotes({ own, global, external });
    expect(all).toHaveLength(120);
    // No refresh list: its 20 slots go round the others.
    expect(all.filter((name) => name.startsWith('glob-')).length).toBeGreaterThanOrEqual(40);
    expect(all.filter((name) => name.startsWith('ext-')).length).toBeGreaterThanOrEqual(30);
    expect(all.filter((name) => name.startsWith('own-')).length).toBeGreaterThanOrEqual(30);
    expect(pickNotes({ external })).toHaveLength(65);
    expect(pickNotes({ own: own.slice(0, 5), external: external.slice(0, 3) })).toHaveLength(8);
    expect(pickNotes({ own })).toHaveLength(70);
    const refresh = [...global].reverse();
    const four = pickNotes({ own, global, external, refresh });
    expect(four).toHaveLength(120);
    // Refresh takes glob-69..glob-50, global its own 40 from the top, own and external 30 each.
    expect(four.filter((name) => name.startsWith('glob-'))).toHaveLength(60);
    expect(four.filter((name) => name.startsWith('own-'))).toHaveLength(30);
    expect(four.filter((name) => name.startsWith('ext-'))).toHaveLength(30);
    expect(four).toEqual(expect.arrayContaining(['glob-69', 'glob-50', 'glob-39', 'ext-29']));
    expect(four).not.toContain('glob-45');
    // Listed own, global, then external, in their order, whichever share took them.
    expect(four.slice(0, 2)).toEqual(['own-0', 'own-1']);
    expect(four[30]).toBe('glob-0');
    // A least shown note that is also among the most read is listed once, and its own share takes the next.
    const shared = pickNotes({ own: own.slice(0, 35), refresh: [own[0]!] });
    expect(shared).toHaveLength(35);
    expect(new Set(shared).size).toBe(35);
  });

  it('lists the knowledge layer instead of the raw notes it covers, and the topics this chat went into as its own', async () => {
    const manifest: DigestManifest = {
      version: 1,
      updatedAt: 1,
      sources: {
        'oc_1/build': { hash: 'h', entries: { a1a1a1: 'global/build', b2b2b2: null } },
        'oc_9/deploy': { hash: 'h', entries: { c3c3c3: 'global/deploy', d4d4d4: 'global-owner/hosts' } },
        'external/feishu-card': { hash: 'h', entries: { e5e5e5: 'global-external/feishu' } },
      },
    };
    const store = fakeStore({
      manifest,
      notes: {
        oc_1: ['build', 'fresh'],
        oc_9: ['deploy'],
        global: ['build', 'deploy'],
        'global-owner': ['hosts'],
        'global-external': ['feishu'],
        external: ['feishu-card', 'au-timezone'],
      },
    });
    const ctx = await buildKnowledgeContext({ store, scopeId: 'oc_1' });
    // Own: the raw note not folded in yet, then the layer topic its notes went into.
    expect(ctx?.notes).toEqual(['oc_1/fresh', 'global/build', 'global/deploy', 'global-external/feishu', 'external/au-timezone']);
    // Only the owner's private chat is shown the owner layer; other chats' raw notes never.
    const owner = await buildKnowledgeContext({ store, scopeId: 'oc_9', ownerPrivate: true });
    expect(owner?.notes).toEqual(['global/deploy', 'global-owner/hosts', 'global/build', 'global-external/feishu', 'external/au-timezone']);
  });

  it('gives a layer topic split into parts one slot, its parts listed together and in order', async () => {
    const many = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(2, '0')}t`);
    const store = fakeStore({
      notes: {
        // charger is read most but its parts least; ops-2 alone is in the most read.
        global: ['charger-3', 'charger', ...many('g', 150), 'charger-2', 'ops-2', 'ops'],
        oc_1: ['raw-2', 'raw'],
        external: [],
      },
      rank: { 'global/charger': 99, 'global/ops-2': 98 },
    });
    const ctx = await buildKnowledgeContext({ store, scopeId: 'oc_1' });
    const notes = ctx?.notes ?? [];
    // Raw notes are never grouped; the parts of a topic sit together, part 1 first.
    expect(notes.slice(0, 2)).toEqual(['oc_1/raw-2', 'oc_1/raw']);
    const at = notes.indexOf('global/charger');
    expect(notes.slice(at, at + 3)).toEqual(['global/charger', 'global/charger-2', 'global/charger-3']);
    const ops = notes.indexOf('global/ops');
    expect(notes.slice(ops, ops + 2)).toEqual(['global/ops', 'global/ops-2']);
    // 120 topics: 2 raw + charger + ops + 116 others, listed in 123 names.
    expect(notes).toHaveLength(123);
    expect(ctx?.truncated).toBe(true);
  });

  it('names the notes a block lists, by name or by path', () => {
    expect(listedNoteNames({ notesDir: NOTES, notes: ['oc_1/a', 'external/b'] })).toEqual(['oc_1/a', 'external/b']);
    expect(listedNoteNames({ notes: ['/x/oc_1/a.md', '/y/external/b.md'] })).toEqual(['oc_1/a', 'external/b']);
    expect(listedNoteNames({})).toEqual([]);
  });

  it('leaves out the skills the agent CLI already lists on its own', async () => {
    const ctx = await buildKnowledgeContext({
      store: fakeStore(),
      scopeId: 'oc_1',
      nativeSkillDirs: new Set(['occam-coffee']),
    });
    expect(ctx?.skills?.map((s) => s.name)).toEqual(['antelope:tcpdump']);
  });

  it('gives a resumed conversation a stub naming the version and a snapshot file', () => {
    expect(knowledgeStub('0123456789abcdef', '/snap/0123456789abcdef.json')).toEqual({
      unchangedSince: '0123456789abcdef',
      snapshot: '/snap/0123456789abcdef.json',
    });
  });
});

describe('claudeSessionHasKnowledge', () => {
  let home: string | undefined;
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    home = undefined;
  });

  async function transcript(lines: unknown[]): Promise<{ env: NodeJS.ProcessEnv; cwd: string }> {
    home = await mkdtemp(join(tmpdir(), 'kb-session-'));
    const cwd = '/work/space';
    const dir = join(home, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 's1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    return { env: { CLAUDE_CONFIG_DIR: home }, cwd };
  }

  const userTurn = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
  const knowledge = (version: string) => promptSection('bridge_knowledge', { version, profileMemory: ['x'] });

  it('is true while the full block of that version sits after the last compaction', async () => {
    const { env, cwd } = await transcript([
      userTurn(`${knowledge('aaaaaaaaaaaaaaaa')}\n<user_input>hi</user_input>`),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      userTurn(`${promptSection('bridge_knowledge', knowledgeStub('aaaaaaaaaaaaaaaa'))}\n<user_input>again</user_input>`),
    ]);
    expect(claudeSessionHasKnowledge('s1', cwd, 'aaaaaaaaaaaaaaaa', env)).toBe(true);
    // Another version, or only a stub naming it: send the block.
    expect(claudeSessionHasKnowledge('s1', cwd, 'bbbbbbbbbbbbbbbb', env)).toBe(false);
  });

  it('is false once the conversation was compacted after the block', async () => {
    const { env, cwd } = await transcript([
      userTurn(`${knowledge('aaaaaaaaaaaaaaaa')}\n<user_input>hi</user_input>`),
      { type: 'system', subtype: 'compact_boundary' },
      userTurn('<user_input>after</user_input>'),
    ]);
    expect(claudeSessionHasKnowledge('s1', cwd, 'aaaaaaaaaaaaaaaa', env)).toBe(false);
  });

  it('is false without a transcript', () => {
    expect(claudeSessionHasKnowledge('missing', '/nowhere', 'aaaaaaaaaaaaaaaa', { CLAUDE_CONFIG_DIR: '/nonexistent' })).toBe(false);
  });
});
