import type { ProfileConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import { claudeAccountName } from './claude/account';
import {
  accountRows,
  accountsBriefTable,
  accountsReport,
  accountsTable,
  bestSwitchTarget,
  claudeAccountPool,
  claudeAccountsPaths,
  findAccountRow,
  formatDaysHours,
  formatHoursMinutes,
  parseSwitchQuery,
  SWITCH_SCORE_WEIGHTS,
  switchBoost,
  switchRefusal,
  switchToAccount,
  WINDOW_KINDS,
  type AccountWindowView,
  type ClaudeAccountEntry,
  type AccountRow,
} from './claude/accounts';
import { probeAccountQuota } from './claude/quota-probe';
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

const ACCOUNT_REPORTS: Record<AgentKind, (profileDir: string) => Promise<string[] | undefined>> = {
  claude: async (profileDir) => {
    const pool = claudeAccountPool(profileDir);
    await pool.refresh();
    if (!pool.multi) return undefined;
    const lines = pool.defaultLines;
    return [
      `**订阅账户**（▶ 为新任务使用的账户。主账户没到切换线就一直用它，到线后换到没到线的账户里得分最高的一个，并把它设为主账户；都到线后同样按得分把各账户用到额度耗尽；全部耗尽才暂停，到最早恢复的账户重置时自动续跑。默认切换线：5 小时 ${lines.five_hour}% · 本周 ${lines.seven_day}%）`,
      ...accountsReport(pool, await claudeAccountName()),
    ];
  },
  codex: () => Promise.resolve(undefined),
};

/**
 * The profile's subscription accounts and how full each is, as Markdown lines
 * for `/usage`. Undefined when the profile has only one account.
 */
export function agentAccountsReport(profileConfig: AccountProfile, profileDir: string): Promise<string[] | undefined> {
  return (ACCOUNT_REPORTS[profileConfig.agentKind]?.(profileDir) ?? Promise.resolve(undefined)).catch(() => undefined);
}

const SCORE_NOTE = `得分 = ${SWITCH_SCORE_WEIGHTS.weekRoom} × 本周余量 + ${SWITCH_SCORE_WEIGHTS.weekExpiring} × 本周余量 × 本周重置临近度 + ${SWITCH_SCORE_WEIGHTS.fiveHourRoom} × 5 小时余量。余量 = 1 − 用量 ÷ 切换线，临近度 = 1 − 距本周重置 ÷ 7 天；已到任一切换线的账户记 0 分；没运行过的账户余量按一半算。`;

/** `5 小时 / 本周` — the windows a switch by name raised. */
function boostedWindows(boost: NonNullable<ClaudeAccountEntry['boost']>): string {
  return WINDOW_KINDS.filter((kind) => boost[kind])
    .map((kind) => (kind === 'five_hour' ? '5 小时' : '本周'))
    .join(' / ');
}

/**
 * `/accounts`: the profile's Claude subscription accounts as one table —
 * usage, resets and switch lines per window. Undefined for other agents.
 */
export async function agentAccountsTable(profileConfig: AccountProfile, profileDir: string): Promise<string | undefined> {
  if (profileConfig.agentKind !== 'claude') return undefined;
  const pool = claudeAccountPool(profileDir);
  await pool.refresh();
  const rows = accountRows(pool, await claudeAccountName());
  return [
    '**Claude 订阅账户**（✅ 为新任务正在用的账户；到切换线后自动换到得分最高的可用账户，并设为主账户）',
    '',
    accountsTable(rows),
    '',
    `_用量和重置时间取自各账户最近一次运行的报告。${SCORE_NOTE}_`,
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
): Promise<string> {
  if (profileConfig.agentKind !== 'claude') return '只有 Claude profile 能切换订阅账户。';
  const { head, rest } = await switchClaudeAccount(profileDir, query);
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
async function switchClaudeAccount(profileDir: string, query: string | undefined): Promise<{ head: string; rest: string[] }> {
  const parsed = parseSwitchQuery(query);
  if ('error' in parsed) return { head: `❌ ${parsed.error}`, rest: [] };
  const pool = claudeAccountPool(profileDir);
  await pool.refresh();
  const label = await claudeAccountName();
  const rows = accountRows(pool, label);
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
  const after = accountRows(pool, label);
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

/** The 订阅账号 panel of the `/config` card. */
export interface AccountsPanel {
  /** Markdown: every account's usage, resets and state. */
  table: string;
  /** The accounts a click may switch to (all but the one new runs use), with why a switch would be refused. */
  targets: Array<{ id: string; name: string; refusal?: string }>;
}

/**
 * How long the `/config` card waits for the CLI login's name: `claude auth
 * status` takes from one to over ten seconds on Windows. Past it the login
 * shows as 「CLI 登录」; the lookup goes on and is cached for the next card.
 */
const CARD_NAME_WAIT_MS = 1_500;

function claudeLoginNameSoon(): Promise<string | undefined> {
  return Promise.race([
    claudeAccountName(),
    new Promise<undefined>((resolve) => {
      setTimeout(() => resolve(undefined), CARD_NAME_WAIT_MS).unref();
    }),
  ]);
}

/** The profile's subscription accounts for the `/config` card. Undefined for agents without them. */
export async function agentAccountsPanel(profileConfig: AccountProfile, profileDir: string): Promise<AccountsPanel | undefined> {
  if (profileConfig.agentKind !== 'claude') return undefined;
  const pool = claudeAccountPool(profileDir);
  await pool.refresh();
  const rows = accountRows(pool, await claudeLoginNameSoon());
  return {
    table: accountsBriefTable(rows),
    targets: rows
      .filter((row) => !row.next)
      .map((row) => {
        const refusal = switchRefusal(pool, row);
        return { id: row.id, name: row.name, ...(refusal ? { refusal } : {}) };
      }),
  };
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
