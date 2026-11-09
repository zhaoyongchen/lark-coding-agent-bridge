import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState, reduce } from '../../../src/card/run-state';

describe('run card byline usage', () => {
  const finished = reduce(reduce(initialState, { type: 'text', delta: 'answer' }), {
    type: 'done',
    terminationReason: 'normal',
  });

  it('shows the turn usage after the other byline parts once the run is over', () => {
    const card = JSON.stringify(
      renderCard(finished, { meta: { title: 'CC', agent: 'claude', usage: '25k in / 51 out · ≈$0.03' } }),
    );
    expect(card).toContain('Agent: claude | Usage: 25k in / 51 out · ≈$0.03');
  });

  it('leaves the byline unchanged when no usage was reported', () => {
    const card = JSON.stringify(renderCard(finished, { meta: { title: 'CC', agent: 'claude' } }));
    expect(card).not.toContain('Usage:');
  });

  it('puts a conversation notice at the top, above the answer — it happened before the run', () => {
    const card = JSON.stringify(
      renderCard(finished, { meta: { title: 'CC', agent: 'claude', notice: '本轮从新会话开始' } }),
    );
    expect(card).toContain('🔄 本轮从新会话开始');
    expect(card.indexOf('本轮从新会话开始')).toBeLessThan(card.indexOf('answer'));
  });

  it('shows the notice while the run is still going', () => {
    const running = reduce(initialState, { type: 'text', delta: 'working' });
    const card = JSON.stringify(renderCard(running, { meta: { title: 'CC', notice: '本轮从新会话开始' } }));
    expect(card).toContain('🔄 本轮从新会话开始');
  });

  it('warns about a large context with a button that starts a new session', () => {
    const rendered = renderCard(finished, {
      meta: { title: 'CC', agent: 'claude', contextWarning: { level: 'large', tokens: 250_000, percent: 25 } },
    });
    const card = JSON.stringify(rendered);
    expect(card).toContain('上下文已约 25 万 token（约占窗口 25%）');
    expect(card).toContain('/new');
    expect(card.indexOf('上下文已约')).toBeLessThan(card.indexOf('Agent: claude'));
    const button = findButton(rendered, '🆕 开新会话');
    expect(button).toMatchObject({ behaviors: [{ type: 'callback', value: { cmd: 'new' } }] });
    expect(button).toHaveProperty('confirm');
  });

  it('words the warning for a context close to auto-compaction, in the caller language', () => {
    const meta = { title: 'CC', contextWarning: { level: 'near-compact' as const, tokens: 260_000, percent: 87 } };
    expect(JSON.stringify(renderCard(finished, { meta }))).toContain('快到自动压缩线');
    const en = JSON.stringify(renderCard(finished, { meta, locale: 'en' }));
    expect(en).toContain('Context is about 260k tokens (~87% of the window)');
    expect(en).toContain('🆕 New session');
  });

  it('keeps the warning off a card that is still running', () => {
    const running = reduce(initialState, { type: 'text', delta: 'partial' });
    const card = JSON.stringify(
      renderCard(running, { meta: { title: 'CC', contextWarning: { level: 'large', tokens: 250_000 } } }),
    );
    expect(card).not.toContain('上下文已约');
  });
});

function findButton(node: unknown, label: string): unknown {
  if (!node || typeof node !== 'object') return undefined;
  const el = node as { tag?: unknown; text?: { content?: unknown } };
  if (el.tag === 'button' && el.text?.content === label) return node;
  for (const value of Object.values(node)) {
    const hit = findButton(value, label);
    if (hit) return hit;
  }
  return undefined;
}
