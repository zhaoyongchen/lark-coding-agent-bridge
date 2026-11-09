import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as unknown,
  createLarkChannel: vi.fn((_opts: unknown) => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return { ...actual, createLarkChannel: sdkMock.createLarkChannel };
});

import { startChannel } from '../../../src/bot/channel.js';

/**
 * A streamed-input process the test drives by hand: it outlives its turn,
 * takes `send` as the next turn, and exits only when stopped — like
 * `claude --input-format stream-json` lingering on background tasks.
 */
class LiveRun implements AgentRun {
  readonly runId: string;
  readonly sent: string[] = [];
  private readonly queue: AgentEvent[] = [];
  private wake: (() => void) | undefined;
  private exited = false;

  constructor(readonly opts: AgentRunOptions) {
    this.runId = opts.runId;
  }

  emit(...events: AgentEvent[]): void {
    this.queue.push(...events);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  readonly events: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]: () => this.iterate(),
  };

  send(prompt: string): boolean {
    if (this.exited) return false;
    this.sent.push(prompt);
    return true;
  }

  async stop(): Promise<void> {
    this.exited = true;
    this.emit();
  }

  async waitForExit(): Promise<boolean> {
    return this.exited;
  }

  private async *iterate(): AsyncGenerator<AgentEvent> {
    for (;;) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.exited) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

class LiveAgent implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Live fake';
  readonly runs: LiveRun[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  run(opts: AgentRunOptions): AgentRun {
    const run = new LiveRun(opts);
    this.runs.push(run);
    return run;
  }
}

interface Sent {
  content: unknown;
  options: { replyTo?: string } | undefined;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('后台任务的结论并进下一轮', () => {
  it('keeps the first message waiting, then points it at the answer that carried the result', async () => {
    const h = await harness();

    // 17:16 — the first request ends while a background task still runs.
    await h.channel.handlers.message?.(message({ messageId: 'om_1', content: '对照一下两边的数据' }));
    await waitFor(() => h.agent.runs.length === 1);
    const run = h.agent.runs[0]!;
    run.emit(
      { type: 'system', sessionId: 'sess-1' },
      { type: 'text', delta: '查询还在跑，完成后会通知。' },
      { type: 'background', count: 1 },
      { type: 'done', sessionId: 'sess-1', terminationReason: 'normal' },
    );
    await waitFor(() => h.streamed.some((s) => s.includes('后台任务在跑')));
    await settle();

    expect(h.streamed.join('\n')).not.toContain('上一件事已完成');
    expect(h.reactions).not.toContainEqual(['om_1', 'DONE']);
    expect(h.sent.map((s) => JSON.stringify(s.content)).join('\n')).not.toContain('任务完成');

    // 17:27 — the next message is handed to the same process, and the
    // background result lands in its turn.
    await h.channel.handlers.message?.(message({ messageId: 'om_2', content: '另一件事' }));
    await waitFor(() => run.sent.length === 1);
    expect(h.agent.runs).toHaveLength(1);
    expect(readInstructions(run.sent[0]!)).toEqual(
      expect.arrayContaining([expect.stringContaining('「对照一下两边的数据」')]),
    );

    run.emit(
      { type: 'text', delta: '另一件事的回答。\n\n**对照数据的结论**\n两边一致。' },
      { type: 'background', count: 0 },
      { type: 'done', sessionId: 'sess-1', terminationReason: 'normal' },
    );
    await waitFor(() => h.sent.some((s) => s.options?.replyTo === 'om_1'));

    const pointer = h.sent.find((s) => s.options?.replyTo === 'om_1')!;
    expect(JSON.stringify(pointer.content)).toContain('结论见');
    expect(JSON.stringify(pointer.content)).toContain('「另一件事」');
    await waitFor(() => h.reactions.some(([id, type]) => id === 'om_1' && type === 'DONE'));
    expect(h.streamed.join('\n')).not.toContain('上一件事已完成');
  });

  it('settles the first message under its own follow-up when the result comes back on its own', async () => {
    const h = await harness();

    await h.channel.handlers.message?.(message({ messageId: 'om_1', content: '跑个长查询' }));
    await waitFor(() => h.agent.runs.length === 1);
    const run = h.agent.runs[0]!;
    run.emit(
      { type: 'system', sessionId: 'sess-1' },
      { type: 'text', delta: '查询在后台跑。' },
      { type: 'background', count: 1 },
      { type: 'done', sessionId: 'sess-1', terminationReason: 'normal' },
    );
    await waitFor(() => h.streamed.some((s) => s.includes('后台任务在跑')));
    await settle();
    expect(h.reactions).not.toContainEqual(['om_1', 'DONE']);

    run.emit(
      { type: 'text', delta: '查询结果：一致。' },
      { type: 'background', count: 0 },
      { type: 'done', sessionId: 'sess-1', terminationReason: 'normal' },
    );
    await waitFor(() => h.reactions.some(([id, type]) => id === 'om_1' && type === 'DONE'));
    // Its own follow-up carries the result: no pointer back to itself.
    expect(h.sent.filter((s) => s.options?.replyTo === 'om_1').map((s) => JSON.stringify(s.content))).not.toEqual(
      expect.arrayContaining([expect.stringContaining('结论见')]),
    );
  });
});

async function harness() {
  const tmp = await createTmpProfile('background-origin-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedChats: ['oc_chat'], allowedUsers: ['ou_user'] },
  });
  const cfg = { ...base, workspaces: { ...base.workspaces, default: workspace } };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new LiveAgent();
  const channel = fakeChannel();
  sdkMock.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    controls: {
      profile: 'test',
      profileConfig: cfg,
      ownerRefreshState: 'unknown' as const,
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: '/tmp/config.json',
      cfg,
      processId: 'proc_test',
    },
    appPaths: testAppPaths(tmp),
  });
  cleanups.push(async () => {
    await bridge.disconnect();
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { agent, channel, sent: channel.sent, streamed: channel.streamed, reactions: channel.reactions };
}

function fakeChannel() {
  const handlers: { message?: (msg: NormalizedMessage) => Promise<void> | void } = {};
  const sent: Sent[] = [];
  const streamed: string[] = [];
  const reactions: Array<[string, string]> = [];
  return {
    handlers,
    sent,
    streamed,
    reactions,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: { application: { get: vi.fn(async () => ({ data: { app: { owner: { owner_id: 'ou_owner' } } } })) } },
      },
      im: { v1: { message: { get: vi.fn(async () => ({ data: { items: [] } })) } } },
    },
    on(next: typeof handlers) {
      Object.assign(handlers, next);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group' as const;
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async addReaction(messageId: string, type: string) {
      reactions.push([messageId, type]);
      return `reaction_${reactions.length}`;
    },
    async removeReaction() {},
    async send(_chatId: string, content: unknown, options?: { replyTo?: string }) {
      sent.push({ content, options });
      return { messageId: `om_sent_${sent.length}` };
    },
    async stream(_chatId: string, input: unknown) {
      if (input && typeof input === 'object' && 'markdown' in input) {
        const md = (input as { markdown(ctrl: { setContent(s: string): Promise<void> }): Promise<void> | void }).markdown;
        await md({
          setContent: async (markdown: string) => {
            streamed.push(markdown);
          },
        });
      }
    },
  };
}

function message(input: { messageId: string; content: string }): NormalizedMessage {
  return {
    messageId: input.messageId,
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
  } as NormalizedMessage;
}

function readInstructions(prompt: string): unknown {
  const match = prompt.match(/<bridge_instructions>\n?([\s\S]*?)\n?<\/bridge_instructions>/);
  return match ? JSON.parse(match[1]!) : undefined;
}

/** Let the run's finally block and fire-and-forget sends land. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}

function testAppPaths(tmp: TmpProfile) {
  return {
    secretsFile: join(tmp.profile, 'secrets.enc'),
    keystoreSaltFile: join(tmp.profile, 'keystore.salt'),
    mediaDir: join(tmp.profile, 'media'),
    runsFile: join(tmp.profile, 'runs.json'),
    knowledgeDir: join(tmp.profile, 'knowledge'),
    jobsFile: join(tmp.profile, 'jobs.json'),
    pendingFile: join(tmp.profile, 'pending.json'),
    rotationsFile: join(tmp.profile, 'pending-rotations.json'),
    usageFile: join(tmp.profile, 'usage.json'),
    auditFile: join(tmp.profile, 'audit.jsonl'),
    profileDir: tmp.profile,
  };
}
