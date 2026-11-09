import { describe, expect, it } from 'vitest';
import { backgroundLeft, initialState, reduce, type RunState } from '../../../src/card/run-state';
import { renderCard } from '../../../src/card/run-renderer';
import { renderText } from '../../../src/card/text-renderer';

const done = { type: 'done', terminationReason: 'normal' } as const;

function run(...events: Parameters<typeof reduce>[1][]): RunState {
  return events.reduce(reduce, initialState);
}

describe('answer in, background tasks still running', () => {
  it('keeps the last count the agent reported', () => {
    expect(backgroundLeft(run({ type: 'background', count: 3 }, { type: 'text', delta: '还在等' }, done))).toBe(3);
    expect(backgroundLeft(run({ type: 'background', count: 3 }, { type: 'background', count: 0 }, done))).toBe(0);
    expect(backgroundLeft(run({ type: 'text', delta: 'ok' }, done))).toBe(0);
  });

  it('counts only once the turn is done', () => {
    expect(backgroundLeft(run({ type: 'background', count: 2 }))).toBe(0);
    expect(backgroundLeft(undefined)).toBe(0);
  });

  it('tells the reader the task is not over instead of 已完成', () => {
    const state = run({ type: 'background', count: 3 }, { type: 'text', delta: '还在等对照查询' }, done);
    const card = JSON.stringify(renderCard(state, { meta: { title: 'Occam' } }));
    expect(card).toContain('还有 3 个后台任务在跑');
    expect(card).toContain('后台任务还在跑');
    expect(card).not.toContain('已完成');
    expect(renderText(state)).toContain('还有 3 个后台任务在跑');
  });

  it('leaves a finished card as before', () => {
    const state = run({ type: 'background', count: 0 }, { type: 'text', delta: '结论' }, done);
    const card = JSON.stringify(renderCard(state, { meta: { title: 'Occam' } }));
    expect(card).not.toContain('后台任务');
    expect(card).toContain('已完成');
  });
});
