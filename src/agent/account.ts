import type { ProfileConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import { claudeAccountName } from './claude/account';
import {
  accountBrief,
  accountRows,
  accountsReport,
  accountsTable,
  bestSwitchTarget,
  claudeAccountPool,
  claudeAccountsPaths,
  expiringFirstNote,
  findAccountRow,
  findPausedAccount,
  formatDaysHours,
  formatHoursMinutes,
  GRACE_LINE,
  parseSwitchQuery,
  pausedNote,
  offDayNote,
  pausedRefusal,
  SWITCH_SCORE_WEIGHTS,
  switchBoost,
  switchRefusal,
  switchToAccount,
  WINDOW_KINDS,
  WORTH_MOVING_ROOM,
  type AccountBrief,
  type AccountWindowView,
  type ClaudeAccountEntry,
  type AccountRow,
  type AccountNameView,
} from './claude/accounts';
import { probeAccountQuota, refreshAllQuota } from './claude/quota-probe';
import { currentStaggerPlan, FIVE_HOUR_MS, startWindowStagger, type StaggerSlot } from './claude/window-stagger';
import { codexAccountName, effectiveCodexHome } from './codex/account';
import type { AgentKind } from './registry';

type AccountProfile = Pick<ProfileConfig, 'agentKind' | 'codex'>;

const ACCOUNT_NAMES: Record<AgentKind, (profileConfig: AccountProfile) => Promise<string | undefined>> = {
  claude: () => claudeAccountName(),
  codex: (profileConfig) => codexAccountName(effectiveCodexHome(profileConfig.codex)),
};

/**
 * The account paying for a profile's runs, for the reply card's `Sponsor:`
 * line — the Claude CLI's claude.ai login, or the Codex CLI's ChatGPT login.
 * Undefined when the agent is on an API key or the account can't be read.
 * Shared bot / scheduler code goes through here so it never imports an
 * agent's internals directly.
 */
export function agentAccountName(profileConfig: AccountProfile): Promise<string | undefined> {
  return ACCOUNT_NAMES[profileConfig.agentKind]?.(profileConfig) ?? Promise.resolve(undefined);
}

const ACCOUNT_REPORTS: Record<AgentKind, (profileDir: string, view: AccountNameView) => Promise<string[] | undefined>> = {
  claude: async (profileDir, view) => {
    const pool = claudeAccountPool(profileDir);
    await pool.refresh();
    if (!pool.multi) return undefined;
    const lines = pool.defaultLines;
    return [
      `**订阅账户**（▶ 为新任务使用的账户。主账户没到切换线就一直用它，到线后换到没到线的账户里得分最高的一个，并把它设为主账户；都到线后同样按得分把各账户用到额度耗尽；全部耗尽才暂停，到最早恢复的账户重置时自动续跑。默认切换线：5 小时 ${lines.five_hour}% · 本周 ${lines.seven_day}%）`,
      ...accountsReport(pool, await claudeAccountName(), Date.now(), view),
    ];
  },
  codex: () => Promise.resolve(undefined),
};

/**
 * The profile's subscription accounts and how full each is, as Markdown lines
 * for `/usage`. Undefined when the profile has only one account.
 */
export function agentAccountsReport(
  profileConfig: AccountProfile,
  profileDir: string,
  view: AccountNameView = {},
): Promise<string[] | undefined> {
  return (ACCOUNT_REPORTS[profileConfig.agentKind]?.(profileDir, view) ?? Promise.resolve(undefined)).catch(() => undefined);
}

/**
 * Keep the profile's Claude accounts' 5-hour windows evenly staggered while
 * the bridge runs (see `window-stagger.ts`). Undefined for other agents.
 */
export function startAgentWindowStagger(
  profileConfig: Pick<ProfileConfig, 'agentKind'>,
  profileDir: string,
): { stop(): Promise<void> } | undefined {
  if (profileConfig.agentKind !== 'claude') return undefined;
  return startWindowStagger({ pool: claudeAccountPool(profileDir) });
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** `/accounts`: when each account's next 5-hour window opens, in that order. */
export function staggerNote(plan: StaggerSlot[], rows: AccountRow[]): string | undefined {
  if (plan.length < 2) return undefined;
  const name = (id: string): string => rows.find((row) => row.id === id)?.name ?? id;
  const step = Math.round(FIVE_HOUR_MS / plan.length / 60_000);
  const order = [...plan].sort((a, b) => a.warmAt - b.warmAt);
  const held = order.filter((slot) => slot.delayMs > 0).map((slot) => name(slot.id));
  return [
    `**5 小时窗口错峰**：${plan.length} 个账户每 ${step} 分钟错开一个重置；对齐以后，大任务把几个账户用光时，每隔约 ${step} 分钟就有一个账户的 5 小时额度恢复。`,
    `下一轮开窗：${order.map((slot) => `${name(slot.id)} ${clock(slot.warmAt)}`).join(' → ')}（各自 5 小时后重置）。`,
    ...(held.length > 0
      ? [`${held.join('、')} 的窗口要往后挪才能错开：重置后先空着（额度是满的，照常能用），到点才发一条 haiku 小请求开窗；查额度也不再顺手把它的窗口打开。`]
      : []),
  ].join('\n');
}

const SCORE_NOTE = `选号按「先到期先用」：本周额度先重置的账户先用，用到切换线再换下一个，到期没用掉的额度就白费了，晚重置的账户之后还能用。得分 = ${SWITCH_SCORE_WEIGHTS.weekExpiring} × 本周重置临近度 × 足额系数 + ${SWITCH_SCORE_WEIGHTS.weekRoom} × 本周余量 + ${SWITCH_SCORE_WEIGHTS.fiveHourRoom} × 5 小时余量。余量 = 1 − 用量 ÷ 切换线，临近度 = 1 − 距本周重置 ÷ 7 天，足额系数 = min(1, 本周余量 ÷ ${WORTH_MOVING_ROOM})（剩不到切换线一成的不值得专门换号）；窗口临近重置时（5 小时窗口：8–21 点剩不到 30 分钟、其他时间不到 1 小时；本周：8–20 点剩不到 4 小时、其他时间不到 6 小时）切换线放宽到 ${GRACE_LINE}%，5 小时余量还按 1 − 距重置 ÷ 临近时长 向满额靠拢，表里写成「原线→${GRACE_LINE}%」，反正重置后额度就回来了。已到任一切换线的账户记 0 分；没运行过的账户余量按一半算。`;

/** `5 小时 / 本周` — the windows a switch by name raised. */
function boostedWindows(boost: NonNullable<ClaudeAccountEntry['boost']>): string {
  return WINDOW_KINDS.filter((kind) => boost[kind])
    .map((kind) => (kind === 'five_hour' ? '5 小时' : '本周'))
    .join(' / ');
}

/** How `/accounts` got its figures: read just now, but for the accounts whose reading failed. */
function freshnessNote(rows: AccountRow[], failed: string[]): string {
  const how = '用量和重置时间是刚读的：CLI 登录账户读 `/usage`，备用账户的 token 读不了 `/usage`，各发一条 haiku 小请求读额度（5 小时窗口已重置、等错峰开窗的备用账户不读，沿用上次读数）。';
  const names = rows.filter((row) => failed.includes(row.id)).map((row) => row.name);
  return names.length > 0 ? `${how}${names.join('、')} 没读到，沿用它最近一次运行的报告。` : how;
}

/**
 * `/accounts`: the profile's Claude subscription accounts as one table —
 * usage, resets and switch lines per window, each account's quota read just
 * now ({@link refreshAllQuota}). Undefined for other agents.
 */
export async function agentAccountsTable(
  profileConfig: AccountProfile,
  profileDir: string,
  view: AccountNameView = {},
): Promise<string | undefined> {
  if (profileConfig.agentKind !== 'claude') return undefined;
  const pool = claudeAccountPool(profileDir);
  await pool.refresh();
  const failed = await refreshAllQuota(pool);
  const rows = accountRows(pool, await claudeAccountName(), Date.now(), view);
  const paused = pausedNote(pool, view);
  const offDay = offDayNote(pool);
  const expiring = expiringFirstNote(rows);
  const stagger = staggerNote(currentStaggerPlan(pool), rows);
  return [
    '**Claude 订阅账户**（✅ 为新任务正在用的账户；到切换线后自动换到得分最高的可用账户，并设为主账户）',
    '',
    accountsTable(rows),
    ...(expiring ? ['', expiring] : []),
    ...(stagger ? ['', stagger] : []),
    ...(paused ? ['', paused] : []),
    ...(offDay ? ['', offDay] : []),
    '',
    `_${freshnessNote(rows, failed)}${SCORE_NOTE}_`,
    '',
    `\`/accounts switch\` 切到得分最高的可用账户；\`/accounts switch <名字或 id>\` 切到指定账户（它要在切换线以下）；\`/accounts switch <名字或 id> <百分比>\` 同时把它的切换线临时调到该值，到该窗口重置恢复原线。`,
  ].join('\n');
}

/**
 * `/accounts switch [name [line]]`: make an account the main one. Without a
 * name, the best-scoring account that has room, other than the current one.
 * By name, that one — only if it is below its switch lines and not refused:
 * a switch obeys the lines like every automatic move — and pinned, so new
 * runs stay on it until it reaches a line whatever the scores say. `line`
 * raises its lines to that value until each window resets ({@link
 * switchBoost}); that is the only way past an account's own line. Returns
 * the reply as Markdown.
 */
export async function switchAgentAccount(
  profileConfig: AccountProfile,
  profileDir: string,
  query?: string,
  view: AccountNameView = {},
): Promise<string> {
  if (profileConfig.agentKind !== 'claude') return '只有 Claude profile 能切换订阅账户。';
  const { head, rest } = await switchClaudeAccount(profileDir, query, view);
  return [head, ...rest].join('\n');
}

/** A switch's outcome as one Markdown line, for the `/config` card that shows the accounts itself. */
export async function switchAgentAccountBrief(
  profileConfig: AccountProfile,
  profileDir: string,
  query: string,
): Promise<string> {
  if (profileConfig.agentKind !== 'claude') return '只有 Claude profile 能切换订阅账户。';
  return (await switchClaudeAccount(profileDir, query)).head;
}

/** The outcome's first line, then the account table and notes that follow it in `/accounts`. */
async function switchClaudeAccount(
  profileDir: string,
  query: string | undefined,
  view: AccountNameView = {},
): Promise<{ head: string; rest: string[] }> {
  const parsed = parseSwitchQuery(query);
  if ('error' in parsed) return { head: `❌ ${parsed.error}`, rest: [] };
  const pool = claudeAccountPool(profileDir);
  await pool.refresh();
  // Pick by what the accounts hold now, not what their last runs said.
  await refreshAllQuota(pool);
  const label = await claudeAccountName();
  const rows = accountRows(pool, label, Date.now(), view);
  if (rows.length < 2) {
    return { head: '只有一个账户，没有可切换的。添加备用账户见 `lark-channel-bridge claude-account add`。', rest: [] };
  }
  // The main account: what a switch moves away from (new runs may already be
  // on another one if it is past a line).
  const current = rows.find((row) => row.index === 0);
  let target: AccountRow | undefined;
  let boost: ClaudeAccountEntry['boost'];
  if (parsed.name) {
    target = findAccountRow(rows, parsed.name);
    const paused = target ? undefined : findPausedAccount(pool, parsed.name, view);
    if (paused) return { head: `⚠️ 没有切换：**${paused.name}** ${pausedRefusal(paused.until)}。`, rest: [] };
    if (!target) {
      return { head: `没有叫「${parsed.name}」的账户。可选：${rows.map((r) => `${r.name}（${r.id}）`).join('、')}`, rest: [] };
    }
    const refusal = switchRefusal(pool, target, parsed.line);
    if (refusal) {
      const hint =
        target.refusedUntil === undefined
          ? `确需继续用它，带上临时切换线：\`/accounts switch ${parsed.name} <高于当前用量的百分比>\`，到该窗口重置恢复原线。`
          : '';
      return { head: `⚠️ 没有切换：**${target.name}** ${refusal}。${hint}`, rest: ['', accountsTable(rows)] };
    }
    if (parsed.line !== undefined) boost = switchBoost(pool, target.id, parsed.line);
  } else {
    target = bestSwitchTarget(rows);
    if (!target) return { head: '其他账户都已到切换线或额度用尽，暂时没有可切换的。', rest: ['', accountsTable(rows)] };
  }
  await switchToAccount(claudeAccountsPaths(profileDir), target.id, boost, Boolean(parsed.name));
  log.info('claude-accounts', 'manual-switch', {
    from: current?.id ?? null,
    to: target.id,
    byName: Boolean(parsed.name),
    line: boost ? (parsed.line ?? null) : null,
  });
  await pool.refresh();
  const after = accountRows(pool, label, Date.now(), view);
  const raised = boost
    ? `切换线临时调到 ${parsed.line}%（${boostedWindows(boost)}），该窗口重置后恢复原线；自动切走时也恢复。`
    : '';
  const pinned = parsed.name ? '在它到切换线之前不会自动换走。' : '';
  const head =
    current?.id === target.id
      ? `✅ 继续用 **${target.name}**。${pinned}${raised}`
      : `✅ 已切换到 **${target.name}**（得分 ${Math.round(target.score * 100)}），从下一条消息起新任务用它${current ? `；之前是 ${current.name}` : ''}。${pinned}${raised}`;
  return { head, rest: ['', accountsTable(after), '', `_${SCORE_NOTE}_`] };
}

/** One account in the 订阅账号 panel of the `/config` card. */
export interface AccountsPanelRow extends AccountBrief {
  id: string;
  name: string;
  /** New runs use it: its button reads its quota; the others' switch to them. */
  current: boolean;
  /** Why a switch to it would be refused. */
  refusal?: string;
}

/**
 * How long the `/config` card waits for the CLI login's name: `claude auth
 * status` takes from one to over ten seconds on Windows. Past it the card
 * uses the last name the CLI gave, or 「CLI 登录」 if it never answered yet.
 */
const CARD_NAME_WAIT_MS = 1_500;

function claudeLoginNameSoon(): Promise<string | undefined> {
  return Promise.race([
    claudeAccountName(),
    new Promise<string | undefined>((resolve) => {
      setTimeout(() => resolve(claudeAccountName.latest()), CARD_NAME_WAIT_MS).unref();
    }),
  ]);
}

/** The profile's subscription accounts for the `/config` card. Undefined for agents without them. */
export async function agentAccountsPanel(
  profileConfig: AccountProfile,
  profileDir: string,
): Promise<AccountsPanelRow[] | undefined> {
  if (profileConfig.agentKind !== 'claude') return undefined;
  const pool = claudeAccountPool(profileDir);
  await pool.refresh();
  const now = Date.now();
  return accountRows(pool, await claudeLoginNameSoon()).map((row) => {
    const refusal = row.next ? undefined : switchRefusal(pool, row);
    return {
      id: row.id,
      name: row.name,
      current: row.next,
      ...accountBrief(row, now),
      ...(refusal ? { refusal } : {}),
    };
  });
}

/**
 * Read the quota of the account new runs use, as it is right now, into the
 * pool (see {@link probeAccountQuota}: the CLI's own login reads `/usage`, a
 * token account spends one tiny haiku request). Returns the outcome as one
 * Markdown line.
 */
export async function refreshAgentAccountQuota(profileConfig: AccountProfile, profileDir: string): Promise<string> {
  if (profileConfig.agentKind !== 'claude') return '只有 Claude profile 能查询订阅额度。';
  const pool = claudeAccountPool(profileDir);
  await pool.refresh();
  const account = pool.pick();
  if (!account) return '❌ 没有可用的账户。';
  const ok = await probeAccountQuota(pool, account);
  const row = accountRows(pool, await claudeLoginNameSoon()).find((r) => r.id === account.id);
  const name = row?.name ?? account.label ?? account.id;
  if (!ok || !row) return `❌ 没读到 **${name}** 的额度（查询失败或超时），表里仍是之前的记录。`;
  return `🔄 **${name}** 当前额度：5 小时 ${windowLine(row.windows.five_hour, formatHoursMinutes)} · 本周 ${windowLine(row.windows.seven_day, formatDaysHours)}`;
}

/** `18%（4h19m 后重置）`; `—` when the reading left the window out. */
function windowLine(view: AccountWindowView, format: (ms: number) => string): string {
  if (view.usedPercent === undefined) return '—';
  const reset = view.reset ? '已重置' : view.resetsInMs === undefined ? undefined : `${format(view.resetsInMs)} 后重置`;
  return `${Math.round(view.usedPercent)}%${reset ? `（${reset}）` : ''}`;
}
