import { describe, expect, it } from 'vitest';
import type { SupplementTarget } from '../../../src/bot/active-runs';
import {
  otherSupplementInstruction,
  supplementPreview,
  supplementRole,
  supplementSignal,
} from '../../../src/bot/supplement';
import { initialState, reduce } from '../../../src/card/run-state';

function target(): SupplementTarget {
  return {
    originIds: new Set(['om_origin']),
    replyIds: new Set(['om_card']),
    initiators: new Set(['ou_starter']),
  };
}

describe('supplementSignal', () => {
  it.each([
    '补充：再看下 EUR',
    '追加一个条件',
    '+ 顺便导出 CSV',
    '/+ 用 staging',
    '  补充 前导空格',
    '/补充 是主机全局记忆',
    '/追加 再加一列',
  ])(
    'treats %j as a supplement by prefix',
    (content) => {
      expect(supplementSignal(content, undefined, target())).toBe('prefix');
    },
  );

  it('treats a quote-reply to the triggering message or the run reply as a supplement', () => {
    expect(supplementSignal('这个也看下', 'om_origin', target())).toBe('quote');
    expect(supplementSignal('这个也看下', 'om_card', target())).toBe('quote');
  });

  it('treats any message in the same topic as a supplement', () => {
    expect(supplementSignal('是主机全局记忆', undefined, target(), true)).toBe('topic');
    expect(supplementSignal('看下这条', 'om_unrelated', target(), true)).toBe('topic');
  });

  it('still reports the stronger signal first inside a topic', () => {
    expect(supplementSignal('这个也看下', 'om_origin', target(), true)).toBe('quote');
    expect(supplementSignal('/补充 换成 EUR', undefined, target(), true)).toBe('prefix');
  });

  it('queues everything else as a new question', () => {
    expect(supplementSignal('新问题：1+1 等于几', undefined, target())).toBeUndefined();
    expect(supplementSignal('帮我补充一下文档', undefined, target())).toBeUndefined();
    expect(supplementSignal('看下这条', 'om_unrelated', target())).toBeUndefined();
  });
});

describe('supplementRole', () => {
  it('lets the owner and the initiator add with the run identity', () => {
    expect(supplementRole(target(), 'ou_owner', true, true)).toBe('owner');
    expect(supplementRole(target(), 'ou_starter', false, true)).toBe('initiator');
    // The owner wins even if the sender type is unknown (e.g. raw event missing).
    expect(supplementRole(target(), 'ou_owner', true, false)).toBe('owner');
    expect(supplementRole(target(), 'ou_starter', false, false)).toBe('initiator');
  });

  it('lets other humans add as "other" and still refuses bots', () => {
    expect(supplementRole(target(), 'ou_someone_else', false, true)).toBe('other');
    expect(supplementRole(target(), 'ou_other_bot', false, false)).toBeUndefined();
  });
});

describe('otherSupplementInstruction', () => {
  it('names the sender and forbids borrowing the run permissions', () => {
    const text = otherSupplementInstruction('李爽');
    expect(text).toContain('「李爽」');
    expect(text).toContain('不是 bot 主人');
    expect(text).toContain('不能借用当前任务的权限');
    expect(otherSupplementInstruction()).toContain('另一位成员');
  });
});

describe('supplementPreview', () => {
  it('drops the prefix, flattens whitespace and truncates long text', () => {
    expect(supplementPreview('补充：\n  换成 EUR', 0)).toBe('换成 EUR');
    expect(supplementPreview('/+ 用 staging', 0)).toBe('用 staging');
    expect(supplementPreview('/补充 是主机全局记忆', 0)).toBe('是主机全局记忆');
    expect(supplementPreview('这个也看下', 0)).toBe('这个也看下');
    expect(supplementPreview('补'.repeat(80), 0)).toBe(`${'补'.repeat(60)}…`);
  });

  it('prefixes the sender when the supplement is not from the initiator', () => {
    expect(supplementPreview('+ nacos没有配置', 0, '李爽')).toBe('（李爽）nacos没有配置');
    expect(supplementPreview('', 1, '李爽')).toBe('（李爽）（1 个附件）');
  });

  it('shows images and files as numbered placeholders instead of raw keys', () => {
    expect(
      supplementPreview('补充：索引相关的，指给我 ![image](img_v3_0216m_9c921048-3999-48b2-9d94-829f) 还有 ![image](img_v3_x)', 1),
    ).toBe('索引相关的，指给我 [图 1] 还有 [图 2]');
    expect(supplementPreview('看这个 <file key="file_v3_abc" name="a.xlsx"/> 和 [image]', 1)).toBe(
      '看这个 [文件 1] 和 [图 1]',
    );
  });

  it('describes attachment-only messages', () => {
    expect(supplementPreview('', 2)).toBe('（2 个附件）');
    expect(supplementPreview('补充', 1)).toBe('（1 个附件）');
  });
});

describe('run-state supplement marker', () => {
  it('closes the streaming text and records where the supplement was read', () => {
    let state = reduce(initialState, { type: 'text', delta: '处理中' });
    state = reduce(state, { type: 'supplement', preview: '加上 EUR' });
    state = reduce(state, { type: 'text', delta: '已按补充调整' });

    expect(state.blocks).toEqual([
      { kind: 'text', content: '处理中', streaming: false },
      { kind: 'text', content: '➕ **收到补充**：加上 EUR', streaming: false },
      { kind: 'text', content: '已按补充调整', streaming: true },
    ]);
  });
});
