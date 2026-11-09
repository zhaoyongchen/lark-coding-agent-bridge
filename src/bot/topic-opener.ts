import type { LarkChannel } from '@larksuite/channel';
import { renderTopicOpenedNotice } from '../card/run-renderer';
import { log } from '../core/logger';

/**
 * 开话题首帖即进度卡片: Feishu has no "create topic" call — a topic exists
 * once the bot replies under a message in thread. That reply used to be a
 * line of its own (「🧵 已开话题，在这里处理。」). Now it is the progress
 * card's opening frame, held here per topic scope until the topic's first
 * run takes it over and keeps updating it in place.
 *
 * A run that never takes it (another reply mode, CoT, a rejected batch…)
 * releases it instead: the card turns into the old notice, so nothing is
 * left saying 「正在思考」 forever.
 */

export interface HeldOpener {
  messageId: string;
  title: string;
  /** What the card says when no run takes it over. */
  fallbackText: string;
}

const held = new Map<string, HeldOpener>();

export function holdTopicOpener(scope: string, opener: HeldOpener): void {
  held.set(scope, opener);
}

/** The opener card waiting in `scope`, handed over once: whoever takes it now owns the card. */
export function takeTopicOpener(scope: string): HeldOpener | undefined {
  const opener = held.get(scope);
  if (!opener) return undefined;
  held.delete(scope);
  return opener;
}

/** The notice an opener card stands for — what it shows when the run leaves nothing in it. */
export function topicOpenedNoticeCard(opener: HeldOpener): object {
  return renderTopicOpenedNotice(opener.title, opener.fallbackText);
}

/** Turn an opener no run took over into the plain notice. No-op once taken. */
export async function releaseTopicOpener(channel: Pick<LarkChannel, 'updateCard'>, scope: string): Promise<void> {
  const opener = held.get(scope);
  if (!opener) return;
  held.delete(scope);
  try {
    await channel.updateCard(opener.messageId, topicOpenedNoticeCard(opener));
    log.info('topic-prefix', 'opener-released', { scope, msgId: opener.messageId });
  } catch (err) {
    log.warn('topic-prefix', 'opener-release-failed', { scope, msgId: opener.messageId, err: String(err) });
  }
}

export interface AdoptedCardCtrl {
  readonly messageId: string;
  update(next: object | ((current: object) => object)): Promise<void>;
  /** One PATCH of the latest card. Looked up on the instance each time so `instrumentCardPatches` can wrap it. */
  patch(): Promise<void>;
}

/**
 * `channel.stream({ card })` for a card that is already on screen: same
 * controller contract (throttled, serialized PATCHes of the latest card, all
 * drained before it resolves), minus the initial send.
 */
export async function adoptCardStream(
  channel: Pick<LarkChannel, 'updateCard'>,
  messageId: string,
  initial: object,
  producer: (ctrl: AdoptedCardCtrl) => Promise<void>,
  throttleMs = 100,
): Promise<{ messageId: string }> {
  let current = initial;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queued = false;
  let chain: Promise<void> = Promise.resolve();
  const ctrl: AdoptedCardCtrl = {
    messageId,
    async update(next) {
      current = typeof next === 'function' ? next(current) : next;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        enqueue();
      }, throttleMs);
    },
    async patch() {
      await channel.updateCard(messageId, current);
    },
  };
  const enqueue = (): void => {
    if (queued) return;
    queued = true;
    chain = chain
      .then(async () => {
        queued = false;
        await ctrl.patch();
      })
      .catch((err: unknown) => log.warn('topic-prefix', 'opener-patch-failed', { msgId: messageId, err: String(err) }));
  };
  const drain = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
      enqueue();
    }
    await chain;
  };
  try {
    await producer(ctrl);
  } finally {
    await drain();
  }
  return { messageId };
}
