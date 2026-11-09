import { describe, expect, it, vi } from 'vitest';
import { adoptCardStream, holdTopicOpener, releaseTopicOpener, takeTopicOpener } from '../../../src/bot/topic-opener.js';
import { renderTopicOpenerCard } from '../../../src/card/run-renderer.js';

describe('topic opener', () => {
  it('hands the held card over once', () => {
    holdTopicOpener('oc_a:omt_1', { messageId: 'om_open', title: 'Occam', fallbackText: '🧵 已开话题' });
    expect(takeTopicOpener('oc_a:omt_1')?.messageId).toBe('om_open');
    expect(takeTopicOpener('oc_a:omt_1')).toBeUndefined();
  });

  it('turns a card no run took into the notice, and leaves a taken one alone', async () => {
    const updateCard = vi.fn(async () => {});
    holdTopicOpener('oc_b:omt_2', { messageId: 'om_left', title: 'Occam', fallbackText: '🧵 已开话题，在这里处理。' });
    await releaseTopicOpener({ updateCard }, 'oc_b:omt_2');
    expect(updateCard).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(updateCard.mock.calls[0])).toContain('已开话题');
    await releaseTopicOpener({ updateCard }, 'oc_b:omt_2');
    expect(updateCard).toHaveBeenCalledTimes(1);
  });

  it('renders the opener as a running progress card without a stop button', () => {
    const card = JSON.stringify(renderTopicOpenerCard('Occam'));
    expect(card).toContain('正在思考');
    expect(card).toContain('Occam');
    expect(card).not.toContain('button');
  });
});

describe('adoptCardStream', () => {
  it('patches the existing message with the latest card and drains before resolving', async () => {
    const updateCard = vi.fn(async () => {});
    const result = await adoptCardStream({ updateCard }, 'om_open', { v: 0 }, async (ctrl) => {
      expect(ctrl.messageId).toBe('om_open');
      await ctrl.update({ v: 1 });
      await ctrl.update({ v: 2 });
    }, 5);
    expect(result).toEqual({ messageId: 'om_open' });
    expect(updateCard).toHaveBeenLastCalledWith('om_open', { v: 2 });
    expect(updateCard.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('goes through a wrapped patch, so card health instrumentation sees every PATCH', async () => {
    const updateCard = vi.fn(async () => {});
    const seen: number[] = [];
    await adoptCardStream({ updateCard }, 'om_open', {}, async (ctrl) => {
      const original = ctrl.patch.bind(ctrl);
      (ctrl as { patch: () => Promise<void> }).patch = async () => {
        seen.push(1);
        await original();
      };
      await ctrl.update({ v: 1 });
    }, 1);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('keeps going when a PATCH fails', async () => {
    const updateCard = vi.fn(async () => Promise.reject(new Error('230020')));
    await expect(
      adoptCardStream({ updateCard }, 'om_open', {}, async (ctrl) => ctrl.update({ v: 1 }), 1),
    ).resolves.toEqual({ messageId: 'om_open' });
  });
});
