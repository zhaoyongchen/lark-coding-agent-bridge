import type { LarkChannel, MentionInfo } from '@larksuite/channel';
import { log } from '../core/logger';
import { planLongRunNotice, sendLongRunNotice, type LongRunRequester } from './long-run-notice';
import { addDoneReaction } from './reaction';

/**
 * 后台任务的原消息. A run that answers while background tasks it started
 * still run leaves its message waiting for the result. The process lingers,
 * and RunExecutor hands the scope's next message to that same process — so
 * when those tasks report back, the CLI folds the result into whichever turn
 * is current, and later follow-ups go to whoever talked to the process last.
 * These entries let that turn tell each waiting message where its result went
 * (or that the work was stopped), instead of leaving it at 「还在等」.
 */
export interface BackgroundOrigin {
  messageId: string;
  chatId: string;
  /** Replies to it go into its topic thread. */
  replyInThread: boolean;
  /** One-line preview of the request, for pointers to and from it. */
  preview: string;
  /** When the request was sent, epoch ms. */
  sentAt: number;
  /** When its run was submitted — the long-run notice measures from here. */
  submittedAt: number;
  p2p: boolean;
  /** Humans whose messages started the run (a group's notice @-mentions them). */
  requesters: LongRunRequester[];
}

/** Waiting messages per scope. In memory: a restart stops the background work anyway. */
export class BackgroundOrigins {
  private readonly byScope = new Map<string, BackgroundOrigin[]>();

  add(scope: string, origin: BackgroundOrigin): void {
    const list = (this.byScope.get(scope) ?? []).filter((o) => o.messageId !== origin.messageId);
    list.push(origin);
    this.byScope.set(scope, list);
  }

  /** The scope's waiting messages, except `exceptIds`. */
  list(scope: string, exceptIds?: ReadonlySet<string>): BackgroundOrigin[] {
    return (this.byScope.get(scope) ?? []).filter((o) => !exceptIds?.has(o.messageId));
  }

  /** Remove and return every waiting message of the scope. */
  take(scope: string): BackgroundOrigin[] {
    const list = this.byScope.get(scope) ?? [];
    this.byScope.delete(scope);
    return list;
  }
}

/** The message whose reply holds the result. */
export interface ResultLocation {
  messageId: string;
  preview: string;
  sentAt: number;
}

export type BackgroundOutcome = 'done' | 'stopped';

/** `17:27「/medium /high …」` — enough to find a message in the chat. */
export function describeMessage(m: { preview: string; sentAt: number }): string {
  return `${formatClock(m.sentAt)}「${m.preview}」`;
}

/** What a waiting message is told when its result landed under another message. */
export function pointerText(outcome: BackgroundOutcome, where: ResultLocation): string {
  return outcome === 'done'
    ? `⬇️ 这件事的后台任务已结束，结论见 ${describeMessage(where)}那条消息的回复。`
    : `⏹ 这件事的后台任务已停止，说明见 ${describeMessage(where)}那条消息的回复。`;
}

/**
 * Standing instruction for a run handed to a process whose background work
 * belongs to earlier messages: answer this one first, and keep that task's
 * result apart so the pointer under its message leads somewhere readable.
 */
export function backgroundTasksInstruction(origins: readonly BackgroundOrigin[], running: number): string {
  const which = origins.map(describeMessage).join('、');
  return (
    `上一件事（${which}）结束时还有 ${running} 个后台任务在跑，这条消息接在同一个进程里处理。` +
    '那些后台任务如果在本轮回报，先回答这条消息，再把那件事的结论单独成段写在最后，用一行加粗标题写明是哪件事；' +
    'bridge 会在那件事的原消息下补一条回复指向这里。不要为了等它们拖住这条消息的回答。'
  );
}

/** Short preview of a message's text for pointers. */
export function messagePreview(text: string, max = 24): string {
  const flat = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export interface SettleInput {
  channel: LarkChannel;
  scope: string;
  origins: readonly BackgroundOrigin[];
  outcome: BackgroundOutcome;
  /** Where the result (or the stop notice) went. */
  where: ResultLocation;
  /** 长任务完成提醒 threshold; `undefined` = off. */
  longRunNoticeMs: number | undefined;
  now?: number;
}

/**
 * Close out every waiting message once the background work is over. The one
 * whose own follow-up carries the result only gets its 「完成」 (reaction, and
 * a group's long-run @); every other one gets a reply pointing at `where`.
 * Best-effort: a failed send is logged, never surfaced.
 */
export async function settleBackgroundOrigins(input: SettleInput): Promise<void> {
  const now = input.now ?? Date.now();
  await Promise.all(
    input.origins.map(async (origin) => {
      const sendOpts = { replyTo: origin.messageId, ...(origin.replyInThread ? { replyInThread: true } : {}) };
      const own = origin.messageId === input.where.messageId;
      log.info('run', 'background-settled', {
        scope: input.scope,
        outcome: input.outcome,
        own,
        msgId: origin.messageId,
      });
      if (input.outcome === 'done') void addDoneReaction(input.channel, origin.messageId);
      if (own) {
        if (input.outcome !== 'done') return;
        // Its follow-up was a message of its own (that pushed): only a group's
        // requesters still need the @.
        const notice = planLongRunNotice({
          thresholdMs: input.longRunNoticeMs,
          elapsedMs: now - origin.submittedAt,
          terminal: 'done',
          p2p: origin.p2p,
          answerIsNewMessage: true,
          requesters: origin.requesters,
        });
        if (notice) await sendLongRunNotice(input.channel, origin.chatId, notice, sendOpts, input.scope);
        return;
      }
      const mentions: MentionInfo[] = origin.p2p
        ? []
        : origin.requesters.map((r) => ({ key: '', openId: r.openId, ...(r.name ? { name: r.name } : {}) }));
      try {
        await input.channel.send(
          origin.chatId,
          { text: pointerText(input.outcome, input.where) },
          { ...sendOpts, ...(mentions.length > 0 ? { mentions } : {}) },
        );
      } catch (err) {
        log.warn('run', 'background-pointer-failed', {
          scope: input.scope,
          msgId: origin.messageId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}

/** `17:27`, in the bridge host's local time. */
function formatClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
