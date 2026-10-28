import { describe, expect, it } from 'vitest';
import { getContextWarning, type AppConfig } from '../../../src/config/schema';
import { contextWarningFor } from '../../../src/session/context-warning';

describe('contextWarningFor', () => {
  const settings = { warnTokens: 200_000 };

  it('stays quiet while the context is small', () => {
    expect(contextWarningFor({ contextTokens: 199_999, contextWindow: 1_000_000 }, settings)).toBeUndefined();
  });

  it('warns once the context reaches the threshold, with its share of the window', () => {
    expect(contextWarningFor({ contextTokens: 250_000, contextWindow: 1_000_000 }, settings)).toEqual({
      level: 'large',
      tokens: 250_000,
      percent: 25,
    });
  });

  it('leaves the share out when the window is unknown', () => {
    expect(contextWarningFor({ contextTokens: 250_000 }, settings)).toEqual({ level: 'large', tokens: 250_000 });
  });

  it('flags a context close to auto-compaction, even under the threshold', () => {
    expect(contextWarningFor({ contextTokens: 180_000, contextWindow: 200_000 }, settings)).toEqual({
      level: 'near-compact',
      tokens: 180_000,
      percent: 90,
    });
  });

  it('measures against the compaction window 会话智能压缩 sets when it is narrower', () => {
    expect(
      contextWarningFor({ contextTokens: 260_000, contextWindow: 1_000_000 }, { ...settings, compactWindowTokens: 300_000 }),
    ).toEqual({ level: 'near-compact', tokens: 260_000, percent: 87 });
  });

  it('says nothing without a context size', () => {
    expect(contextWarningFor({}, settings)).toBeUndefined();
    expect(contextWarningFor({ contextTokens: 0 }, settings)).toBeUndefined();
  });
});

describe('getContextWarning', () => {
  const cfg = (preferences: AppConfig['preferences']) => ({ preferences }) as AppConfig;

  it('is on by default at 200k tokens', () => {
    expect(getContextWarning(cfg(undefined))).toEqual({ warnTokens: 200_000 });
  });

  it('turns off at 0 and falls back to the default when out of range', () => {
    expect(getContextWarning(cfg({ contextWarnTokens: 0 }))).toBeUndefined();
    expect(getContextWarning(cfg({ contextWarnTokens: 500 }))).toEqual({ warnTokens: 200_000 });
    expect(getContextWarning(cfg({ contextWarnTokens: 120_000 }))).toEqual({ warnTokens: 120_000 });
  });

  it('knows the compaction window while 会话智能压缩 is on', () => {
    expect(getContextWarning(cfg({ smartSession: true }))).toEqual({ warnTokens: 200_000, compactWindowTokens: 300_000 });
  });
});
