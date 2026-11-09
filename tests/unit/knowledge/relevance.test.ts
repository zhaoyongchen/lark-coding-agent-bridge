import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { docOf, findRelevantNotes, rankDocs, terms } from '../../../src/knowledge/relevance.js';
import { KnowledgeStore } from '../../../src/knowledge/store.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function storeWith(notes: Record<string, string>): Promise<{ store: KnowledgeStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'relevance-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(notes)) {
    await mkdir(join(dir, 'notes', name.split('/')[0]!), { recursive: true });
    await writeFile(join(dir, 'notes', `${name}.md`), body);
  }
  return { store: new KnowledgeStore(dir), dir };
}

const FILLER = Array.from({ length: 12 }, (_, i) => [`external/filler-${i}`, `# 杂项 ${i}\n部署流程和日志查询的一般说明，第 ${i} 篇。`]);

describe('terms', () => {
  it('splits Latin tokens into their parts and Chinese into character pairs, without filler words', () => {
    expect(terms('看一下 antelope:deploy 的 0x05')).toEqual(['antelope:deploy', 'antelope', 'deploy', '0x05']);
    expect(terms('充电桩代次')).toEqual(['充电', '电桩', '桩代', '代次']);
    expect(terms('这个怎么样')).not.toEqual(expect.arrayContaining(['这个', '怎么']));
  });
});

describe('findRelevantNotes', () => {
  it('finds the notes about what is asked, the best match first', async () => {
    const { store, dir } = await storeWith({
      ...Object.fromEntries(FILLER),
      'oc_1/ev-charger-generation': '# 充电桩代次\n一代桩被当成二代桩时，看 0x15 上报的槽位和型号名。充电桩代次判断。',
      'oc_1/ev-charger-unbind': '# 充电桩解绑\n解绑充电桩时要清掉槽位配置。',
      'external/td-slow-sql': '# TDengine 慢查询\n按指纹归一化后排序。',
    });
    const hit = await findRelevantNotes({ store, scopeId: 'oc_1', query: '充电桩一代被当成二代了，帮忙看下 0x15' });
    expect(hit?.notesDir).toBe(join(dir, 'notes'));
    expect(hit?.notes[0]).toBe('oc_1/ev-charger-generation');
    expect(hit?.notes).not.toContain('external/td-slow-sql');
  });

  it('returns nothing for a message with no topic in it', async () => {
    const { store } = await storeWith({ ...Object.fromEntries(FILLER), 'oc_1/ev-charger-generation': '# 充电桩代次\n一代桩。' });
    expect(await findRelevantNotes({ store, scopeId: 'oc_1', query: '好的，谢谢' })).toBeUndefined();
    expect(await findRelevantNotes({ store, scopeId: 'oc_1', query: '' })).toBeUndefined();
  });

  it("only searches the notes the chat may see: its own and other bots', not other chats'", async () => {
    const { store } = await storeWith({
      ...Object.fromEntries(FILLER),
      'oc_9/ev-charger-generation': '# 充电桩代次\n一代桩被当成二代桩。充电桩代次。',
    });
    expect(await findRelevantNotes({ store, scopeId: 'oc_1', query: '充电桩代次' })).toBeUndefined();
  });
});

describe('rankDocs', () => {
  it('weights the words of a note name above the same words in a body', () => {
    const docs = [
      docOf({ name: 'oc_1/kafka-consumption', path: '/n/oc_1/kafka-consumption.md' }, '# 消费\n看 lag。'),
      docOf({ name: 'oc_1/other', path: '/n/oc_1/other.md' }, '# 其他\n顺带提了一句 kafka。'),
      ...FILLER.map(([name, body]) => docOf({ name: name!, path: `/n/${name}.md` }, body!)),
    ];
    expect(rankDocs(docs, ['kafka', '消费']).map((hit) => hit.note.name)[0]).toBe('oc_1/kafka-consumption');
  });
});
