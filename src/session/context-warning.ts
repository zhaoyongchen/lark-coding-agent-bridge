import type { ContextWarningSettings } from '../config/schema';

/**
 * 上下文过长告警. A conversation that keeps growing gets slower and costlier on
 * every turn (each call re-reads the whole context), and once it reaches the
 * agent CLI's auto-compaction line the earlier details are summarized away.
 * The bridge cannot tell when a task is over, so it tells the user instead: a
 * reply whose turn ended with a large context carries a warning and a
 * 「开新会话」 button on its card.
 *
 * - `large`: the context reached {@link ContextWarningSettings.warnTokens}.
 * - `near-compact`: it filled {@link NEAR_COMPACT_RATIO} of the window the CLI
 *   compacts against, whatever `warnTokens` says.
 */
export type ContextWarningLevel = 'large' | 'near-compact';

export interface ContextWarning {
  level: ContextWarningLevel;
  tokens: number;
  /** Share of the compaction window in use, 0–100; absent when the window is unknown. */
  percent?: number;
}

/** Share of the compaction window from which auto-compaction is close. */
export const NEAR_COMPACT_RATIO = 0.85;

export interface ContextUsage {
  contextTokens?: number;
  contextWindow?: number;
}

/** The warning a turn that ended with `usage` deserves, or `undefined`. */
export function contextWarningFor(usage: ContextUsage, settings: ContextWarningSettings): ContextWarning | undefined {
  const tokens = usage.contextTokens;
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return undefined;
  const window = compactionWindow(usage.contextWindow, settings.compactWindowTokens);
  const percent = window ? Math.min(100, Math.round((tokens / window) * 100)) : undefined;
  const nearCompact = window !== undefined && tokens >= window * NEAR_COMPACT_RATIO;
  if (!nearCompact && tokens < settings.warnTokens) return undefined;
  return {
    level: nearCompact ? 'near-compact' : 'large',
    tokens,
    ...(percent !== undefined ? { percent } : {}),
  };
}

/**
 * The window the CLI auto-compacts against: the model's own, narrowed by the
 * compaction window 会话智能压缩 asks for. Undefined when neither is known.
 */
function compactionWindow(modelWindow: number | undefined, compactWindow: number | undefined): number | undefined {
  const known = [modelWindow, compactWindow].filter(
    (w): w is number => typeof w === 'number' && Number.isFinite(w) && w > 0,
  );
  return known.length > 0 ? Math.min(...known) : undefined;
}
