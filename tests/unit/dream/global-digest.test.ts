import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capEvidence, checkMergedTopic, chunk, ownerOnly, parseLayerFile, renderTopic, runDigest, type MergeJob } from '../../../src/dream/global-digest.js';
import { digestView, parseManifest } from '../../../src/knowledge/digest.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function repo(notes: Record<string, string[]>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'digest-'));
  dirs.push(dir);
  for (const [name, entries] of Object.entries(notes)) {
    const [scope, topic] = name.split('/');
    await mkdir(join(dir, 'notes', scope!), { recursive: true });
    await writeFile(join(dir, 'notes', scope!, `${topic}.md`), `# ${topic}\n\n${entries.join('\n')}\n`, 'utf8');
  }
  return dir;
}

const job = (over: Partial<MergeJob> = {}): MergeJob => ({
  layer: 'internal',
  topic: 'build',
  title: '构建',
  current: [],
  incoming: [
    { id: 'aaaaa1', note: 'oc_1/build', text: '用 mvnd 构建【实测】' },
    { id: 'aaaaa2', note: 'oc_2/build', text: '全量构建用 mvnd -T 10【引用，未核实】' },
    { id: 'aaaaa3', note: 'oc_2/build', text: '构建要加锁' },
    { id: 'aaaaa4', note: 'oc_2/build', text: '构建要加全局锁' },
  ],
  ...over,
});

describe('global digest checks', () => {
  it('accepts a topic that accounts for every entry, and lowers a tag stronger than its sources', () => {
    const merged = checkMergedTopic(
      {
        entries: [
          { section: '构建', text: '全量构建用 mvnd -T 10【实测】', from: ['aaaaa1', 'aaaaa2'], owner: false },
          { section: '构建', text: '构建要加全局锁', from: ['aaaaa4'], owner: false },
        ],
        dropped: [{ id: 'aaaaa3', reason: '与 aaaaa4 重复' }],
      },
      job(),
      new Set(),
    );
    if ('error' in merged) throw new Error(merged.error);
    expect(merged.entries[0]!.text).toBe('全量构建用 mvnd -T 10【引用，未核实】');
    expect(merged.entries[0]!.sources).toEqual(['aaaaa1', 'aaaaa2']);
    expect(merged.placed.get('aaaaa4')).toBe(merged.entries[1]!.id);
  });

  it('rejects a topic that loses an entry or drops more than a quarter', () => {
    const lost = checkMergedTopic({ entries: [{ text: 'x', from: ['aaaaa1'] }], dropped: [] }, job(), new Set());
    expect(lost).toEqual({ error: expect.stringContaining('没有交代去向') });
    const tooMany = checkMergedTopic(
      {
        entries: [{ text: 'x', from: ['aaaaa1', 'aaaaa2'] }],
        dropped: [
          { id: 'aaaaa3', reason: '重复' },
          { id: 'aaaaa4', reason: '重复' },
        ],
      },
      job(),
      new Set(),
    );
    expect(tooMany).toEqual({ error: expect.stringContaining('超过四分之一') });
  });

  it('keeps hosts, people and credentials talk for the owner whatever the model says', () => {
    expect(ownerOnly('经 net-debug 中转')).toBe(true);
    expect(ownerOnly('DNS 指向 198.18.0.55')).toBe(true);
    expect(ownerOnly('飞书 open_id ou_1c0dacdbc941de95db7063310b81c792')).toBe(true);
    expect(ownerOnly('Liquibase changeSet 只改表结构')).toBe(false);
    const merged = checkMergedTopic(
      { entries: [{ text: '库在 10.0.0.1', from: ['aaaaa1', 'aaaaa2', 'aaaaa3', 'aaaaa4'], owner: false }] },
      job(),
      new Set(),
    );
    if ('error' in merged) throw new Error(merged.error);
    expect(merged.entries[0]!.owner).toBe(true);
    expect(capEvidence('结论【实测】', ['来源【猜测】'])).toBe('结论【猜测】');
  });

  it('writes owner entries to global-owner and splits a topic past its size by section', () => {
    const entry = (i: number, section: string, owner = false) => ({ id: `b0000${i}`, section, text: '很长的一条事实'.repeat(100), sources: [`c0000${i}`], owner });
    const topic = { layer: 'internal' as const, topic: 'big', title: '大主题', dropped: [], placed: new Map(), entries: [entry(1, '甲'), entry(2, '乙'), entry(3, '丙'), entry(4, '丁', true)] };
    const files = renderTopic(topic, false, '2026-11-05');
    expect(files.map((file) => file.file)).toEqual(['notes/global/big.md', 'notes/global/big-2.md']);
    expect(renderTopic(topic, true, '2026-11-05').map((file) => file.file)).toEqual(['notes/global-owner/big.md']);
    const parsed = parseLayerFile(files[0]!.body, false);
    expect(parsed.title).toBe('大主题');
    expect(parsed.entries[0]).toMatchObject({ id: 'b00001', section: '甲', sources: ['c00001'] });
    expect(chunk([5, 5, 5], (n) => n, 10)).toEqual([[5, 5], [5]]);
    const one = { ...topic, entries: [entry(1, '甲'), entry(2, '甲'), entry(3, '甲')] };
    const cut = renderTopic(one, false, '2026-11-05');
    expect(cut).toHaveLength(2);
    expect(cut[1]!.body).toContain('## 甲（续）');
    expect(cut.every((file) => Buffer.byteLength(file.body) <= 6 * 1024)).toBe(true);
  });
});

describe('runDigest', () => {
  it('folds raw notes of several chats into one topic, leaves restricted chats out, and then only folds what is new', async () => {
    const dir = await repo({
      'oc_1/build': ['- [aaaaa1] 用 mvnd 构建'],
      'oc_2_omt_9/build-tips': ['- [aaaaa2] 构建要加全局锁'],
      'oc_bad/secret': ['- [aaaaa3] 受限群的事'],
      'external/feishu': ['- [eeeee1] 卡片长度上限'],
    });
    const prompts: string[] = [];
    const run = async (_key: string, prompt: string) => {
      prompts.push(prompt);
      if (prompt.includes('第一步')) {
        const external = prompt.includes('external/feishu');
        return { text: JSON.stringify(external
          ? { assign: [{ note: 'external/feishu', topic: 'feishu' }], topics: [{ topic: 'feishu', title: '飞书', summary: '' }] }
          : { assign: [{ note: 'oc_1/build', topic: 'build' }, { note: 'oc_2_omt_9/build-tips', topic: 'build' }], topics: [{ topic: 'build', title: '构建', summary: '' }] }) };
      }
      const external = prompt.includes('eeeee1');
      const ids = [...prompt.slice(prompt.indexOf('<topics>')).matchAll(/"id":"([0-9a-f]{6})"/g)].map((m) => m[1]);
      return { text: JSON.stringify({ topics: [{ topic: external ? 'feishu' : 'build', entries: [{ section: '要点', text: '合并后的事实', from: ids, owner: false }] }] }) };
    };
    const first = await runDigest({ dir, restricted: new Set(['oc_bad']), run, now: Date.UTC(2026, 10, 5), deadline: Date.now() + 600_000 });
    expect(first.errors).toEqual([]);
    expect(first).toMatchObject({ notes: 3, topics: 2, newTopics: 2, pending: 0 });
    expect(prompts.join('\n')).not.toContain('受限群');
    expect(await readdir(join(dir, 'notes', 'global'))).toEqual(['_manifest.json', 'build.md']);
    expect(await readdir(join(dir, 'notes', 'global-external'))).toEqual(['feishu.md']);
    const manifest = parseManifest(await readFile(join(dir, 'notes', 'global', '_manifest.json'), 'utf8'));
    expect(manifest.sources['oc_1/build']!.entries).toEqual({ aaaaa1: 'global/build' });
    expect([...digestView(manifest).topicsOf('oc_2')]).toEqual(['global/build']);

    // Nothing new: no turn at all.
    prompts.length = 0;
    const idle = await runDigest({ dir, restricted: new Set(['oc_bad']), run, now: Date.UTC(2026, 10, 6), deadline: Date.now() + 600_000 });
    expect(prompts).toEqual([]);
    expect(idle.files).toEqual([]);

    // A new entry in a folded note goes straight to its topic, merged with what the topic has.
    await writeFile(join(dir, 'notes', 'oc_1', 'build.md'), '# build\n\n- [aaaaa1] 用 mvnd 构建\n- [aaaaa9] 单模块在模块目录跑\n', 'utf8');
    const grown = await runDigest({ dir, restricted: new Set(['oc_bad']), run, now: Date.UTC(2026, 10, 7), deadline: Date.now() + 600_000 });
    expect(prompts.some((prompt) => prompt.includes('第一步'))).toBe(false);
    expect(grown).toMatchObject({ notes: 1, topics: 1, newTopics: 0 });
    expect(prompts[0]).toContain('aaaaa9');
    const after = parseManifest(await readFile(join(dir, 'notes', 'global', '_manifest.json'), 'utf8'));
    expect(after.sources['oc_1/build']!.entries.aaaaa9).toBe('global/build');
  });
});
