import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentAccountsPanel,
  refreshAgentAccountQuota,
  switchAgentAccount,
  switchAgentAccountBrief,
} from '../../../src/agent/account';
import {
  claudeAccountPool,
  claudeAccountsPaths,
  readAccountsConfig,
  saveAccount,
  type ClaudeAccountPool,
  type PickedAccount,
} from '../../../src/agent/claude/accounts';

const mocks = vi.hoisted(() => ({
  probe: vi.fn<(pool: ClaudeAccountPool, account: PickedAccount) => Promise<boolean>>(),
}));

vi.mock('../../../src/agent/claude/account', () => ({
  claudeAccountName: vi.fn(async () => 'shilong.wang'),
}));

vi.mock('../../../src/agent/claude/quota-probe', () => ({
  probeAccountQuota: mocks.probe,
}));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const claude = { agentKind: 'claude' } as Parameters<typeof agentAccountsPanel>[0];
const dirs: string[] = [];

beforeEach(() => {
  mocks.probe.mockReset();
});

afterEach(async () => {
  await Promise.all(dirs.map((dir) => claudeAccountPool(dir).flush()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * default (the CLI login) with plenty of room, b past its 5-hour line, c
 * never run: new runs go to default.
 */
async function profile(): Promise<{ dir: string; pool: ClaudeAccountPool }> {
  const dir = await mkdtemp(join(tmpdir(), 'lcb-account-panel-'));
  dirs.push(dir);
  const paths = claudeAccountsPaths(dir);
  await saveAccount(paths, { id: 'b', token: 'tok-b', label: '焦银玲' });
  await saveAccount(paths, { id: 'c', token: 'tok-c' });
  const pool = claudeAccountPool(dir);
  await pool.refresh();
  const now = Date.now();
  pool.observeUsage('default', {
    five_hour: { usedPercent: 10, resetsAt: now + 2 * HOUR },
    seven_day: { usedPercent: 30, resetsAt: now + 3 * DAY },
  });
  pool.observeUsage('b', { five_hour: { usedPercent: 99, resetsAt: now + HOUR } });
  return { dir, pool };
}

describe('the /config 订阅账号 panel', () => {
  it('lists every account, and offers a switch to each one but the current, saying why one is refused', async () => {
    const { dir } = await profile();
    const panel = await agentAccountsPanel(claude, dir);
    expect(panel?.table).toContain('| ✅ **shilong.wang** | 10% / ');
    expect(panel?.table).toContain('| **焦银玲** | 99% / ');
    expect(panel?.targets).toEqual([
      { id: 'b', name: '焦银玲', refusal: '5 小时窗口用量 99%，已到 98% 的切换线' },
      { id: 'c', name: 'c' },
    ]);
  });

  it('has nothing for an agent without subscription accounts', async () => {
    const { dir } = await profile();
    expect(await agentAccountsPanel({ agentKind: 'codex' } as typeof claude, dir)).toBeUndefined();
  });
});

describe('switching from the card', () => {
  it('switches by id and pins the account, so it keeps new runs although default scores better', async () => {
    const { dir, pool } = await profile();
    const head = await switchAgentAccountBrief(claude, dir, 'c');
    expect(head).toMatch(/^✅ 已切换到 \*\*c\*\*（得分 \d+），从下一条消息起新任务用它；之前是 shilong\.wang。在它到切换线之前不会自动换走。$/);
    expect(readAccountsConfig(claudeAccountsPaths(dir)).accounts[0]).toEqual({ id: 'c', pinned: true });
    expect(pool.pick()?.id).toBe('c');
  });

  it('refuses an account past its line, leaving the main account as it was', async () => {
    const { dir } = await profile();
    expect(await switchAgentAccountBrief(claude, dir, 'b')).toMatch(/^⚠️ 没有切换：\*\*焦银玲\*\* 5 小时窗口用量 99%，已到 98% 的切换线。/);
    expect(readAccountsConfig(claudeAccountsPaths(dir)).accounts[0]?.id).toBe('default');
  });

  it('keeps /accounts switch as it was: the outcome, then the table and the score note', async () => {
    const { dir } = await profile();
    const reply = await switchAgentAccount(claude, dir, '');
    // Without a name: the best-scoring ready account other than the main one, not pinned.
    expect(reply.split('\n')[0]).toMatch(/^✅ 已切换到 \*\*c\*\*/);
    expect(reply).not.toContain('不会自动换走');
    expect(reply).toContain('| 账户 | 5 小时用量 / 重置 |');
    expect(reply).toContain('得分 = ');
    expect(readAccountsConfig(claudeAccountsPaths(dir)).accounts[0]).toEqual({ id: 'c' });
  });
});

describe('reading the current account quota from the card', () => {
  it('reads the account new runs use and words both windows', async () => {
    const { dir } = await profile();
    mocks.probe.mockImplementation(async (pool, account) => {
      const now = Date.now();
      pool.observeUsage(account.id, {
        five_hour: { usedPercent: 42, resetsAt: now + 2 * HOUR },
        seven_day: { usedPercent: 61.4, resetsAt: now + 3 * DAY },
      });
      return true;
    });
    expect(await refreshAgentAccountQuota(claude, dir)).toBe(
      '🔄 **shilong.wang** 当前额度：5 小时 42%（2h0m 后重置） · 本周 61%（3d0h 后重置）',
    );
    expect(mocks.probe.mock.calls[0]?.[1].id).toBe('default');
  });

  it('says so when the reading failed', async () => {
    const { dir } = await profile();
    mocks.probe.mockResolvedValue(false);
    expect(await refreshAgentAccountQuota(claude, dir)).toBe(
      '❌ 没读到 **shilong.wang** 的额度（查询失败或超时），表里仍是之前的记录。',
    );
  });
});
