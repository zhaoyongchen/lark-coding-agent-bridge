import { describe, expect, it } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import {
  BackgroundOrigins,
  backgroundTasksInstruction,
  messagePreview,
  pointerText,
  settleBackgroundOrigins,
  type BackgroundOrigin,
} from '../../../src/bot/background-origins';

const at = (h: number, m: number): number => new Date(2026, 10, 1, h, m).getTime();

function origin(over: Partial<BackgroundOrigin> = {}): BackgroundOrigin {
  return {
    messageId: 'om_first',
    chatId: 'oc_dm',
    replyInThread: false,
    preview: '/xhigh 深度分析一下这个问题',
    sentAt: at(17, 16),
    submittedAt: at(17, 16),
    p2p: true,
    requesters: [{ openId: 'ou_owner', name: '王仕龙' }],
    ...over,
  };
}

function fakeChannel() {
  const sent: { chatId: string; text: string; opts: Record<string, unknown> }[] = [];
  const reactions: { messageId: string; type: string }[] = [];
  const channel = {
    send: async (chatId: string, body: { text: string }, opts: Record<string, unknown>) => {
      sent.push({ chatId, text: body.text, opts });
      return { messageId: `om_reply_${sent.length}` };
    },
    addReaction: async (messageId: string, type: string) => {
      reactions.push({ messageId, type });
      return 'r1';
    },
  } as unknown as LarkChannel;
  return { channel, sent, reactions };
}

const second = { messageId: 'om_second', preview: '/medium /high /xhigh 这几个指令', sentAt: at(17, 27) };

describe('messages waiting on background work', () => {
  it('keeps one entry per message and hands them all over at once', () => {
    const store = new BackgroundOrigins();
    store.add('oc_dm', origin());
    store.add('oc_dm', origin({ preview: 'again' }));
    store.add('oc_dm', origin({ messageId: 'om_other' }));
    expect(store.list('oc_dm').map((o) => o.messageId)).toEqual(['om_first', 'om_other']);
    expect(store.list('oc_dm', new Set(['om_other'])).map((o) => o.messageId)).toEqual(['om_first']);
    expect(store.take('oc_dm')).toHaveLength(2);
    expect(store.list('oc_dm')).toEqual([]);
  });

  it('points at the message whose reply holds the result', () => {
    expect(pointerText('done', second)).toBe(
      '⬇️ 这件事的后台任务已结束，结论见 17:27「/medium /high /xhigh 这几个指令」那条消息的回复。',
    );
    expect(pointerText('stopped', second)).toContain('已停止');
  });

  it('asks the next turn to answer its own message first and keep the old result apart', () => {
    const text = backgroundTasksInstruction([origin()], 3);
    expect(text).toContain('17:16「/xhigh 深度分析一下这个问题」');
    expect(text).toContain('3 个后台任务');
    expect(text).toContain('单独成段');
  });

  it('previews a message on one short line', () => {
    expect(messagePreview('<p>/xhigh 深度分析\n一下这个问题</p>')).toBe('/xhigh 深度分析 一下这个问题');
    expect(messagePreview('一'.repeat(40))).toBe(`${'一'.repeat(24)}…`);
  });
});

describe('settling the wait', () => {
  it('replies under the original message when the result landed in another turn', async () => {
    const { channel, sent, reactions } = fakeChannel();
    await settleBackgroundOrigins({
      channel,
      scope: 'oc_dm',
      origins: [origin()],
      outcome: 'done',
      where: second,
      longRunNoticeMs: 10 * 60_000,
      now: at(17, 46),
    });
    expect(sent).toEqual([
      {
        chatId: 'oc_dm',
        text: '⬇️ 这件事的后台任务已结束，结论见 17:27「/medium /high /xhigh 这几个指令」那条消息的回复。',
        opts: { replyTo: 'om_first' },
      },
    ]);
    expect(reactions).toEqual([{ messageId: 'om_first', type: 'DONE' }]);
  });

  it('only marks done in a DM when its own follow-up carried the result', async () => {
    const { channel, sent, reactions } = fakeChannel();
    await settleBackgroundOrigins({
      channel,
      scope: 'oc_dm',
      origins: [origin()],
      outcome: 'done',
      where: { messageId: 'om_first', preview: 'x', sentAt: at(17, 16) },
      longRunNoticeMs: 10 * 60_000,
      now: at(17, 46),
    });
    expect(sent).toEqual([]);
    expect(reactions).toEqual([{ messageId: 'om_first', type: 'DONE' }]);
  });

  it('@-mentions a group requester with the delayed 任务完成 once a long task is over', async () => {
    const { channel, sent } = fakeChannel();
    await settleBackgroundOrigins({
      channel,
      scope: 'oc_group:omt_1',
      origins: [origin({ chatId: 'oc_group', p2p: false, replyInThread: true })],
      outcome: 'done',
      where: { messageId: 'om_first', preview: 'x', sentAt: at(17, 16) },
      longRunNoticeMs: 10 * 60_000,
      now: at(17, 46),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('✅ 任务完成（用时 30 分钟）');
    expect(sent[0]!.opts).toMatchObject({ replyTo: 'om_first', replyInThread: true });
    expect(sent[0]!.opts.mentions).toEqual([{ key: '', openId: 'ou_owner', name: '王仕龙' }]);
  });

  it('says the work was stopped without marking anything done', async () => {
    const { channel, sent, reactions } = fakeChannel();
    await settleBackgroundOrigins({
      channel,
      scope: 'oc_dm',
      origins: [origin(), origin({ messageId: 'om_second' })],
      outcome: 'stopped',
      where: second,
      longRunNoticeMs: 10 * 60_000,
    });
    expect(sent.map((s) => s.opts.replyTo)).toEqual(['om_first']);
    expect(sent[0]!.text).toContain('已停止');
    expect(reactions).toEqual([]);
  });
});
