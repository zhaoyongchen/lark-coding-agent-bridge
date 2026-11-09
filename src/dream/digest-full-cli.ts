/**
 * 全局知识整合层的首次全量构建（或手动重建）：在知识库的一份克隆上跑
 * runDigest({ full: true })，每次模型调用起一个无工具的 `claude -p`。
 *
 *   pnpm tsup src/dream/digest-full-cli.ts --format esm -d .digest-build --no-config
 *   node .digest-build/digest-full-cli.js <知识库克隆> <受限群 id,逗号分隔> [并发] [full|incremental|rerender]
 *   rerender：不调模型，只按当前规则把整合层重新排版、拆分
 *
 * 写完不提交，由人检查后提交、开 PR。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLayer, runDigest, writeTopics } from './global-digest';

const [dir, restrictedArg = '', concurrencyArg = '3', mode = 'full'] = process.argv.slice(2);
if (!dir) {
  console.error('usage: digest-full <knowledge-checkout> <restricted,ids> [concurrency]');
  process.exit(2);
}
const logFile = join(dir, '..', 'digest-full.log');
const say = (line: string) => appendFile(logFile, `${new Date().toISOString()} ${line}\n`);

async function run(key: string, prompt: string): Promise<{ text: string } | { error: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'digest-turn-'));
  await say(`start ${key} (${prompt.length} 字)`);
  return new Promise((resolve) => {
    const child = spawn('claude', ['-p', '--model', 'opus', '--tools', '', '--setting-sources', 'project', '--output-format', 'text'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 20 * 60_000);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('close', async (code) => {
      clearTimeout(timer);
      await say(`done ${key} code=${code} out=${out.length}${err ? ` err=${err.slice(0, 200)}` : ''}`);
      resolve(code === 0 && out.trim() ? { text: out } : { error: `claude 退出码 ${code}：${err.slice(0, 200)}` });
    });
    child.stdin.end(prompt);
  });
}

if (mode === 'rerender') {
  const layer = await readLayer(dir);
  const files = await writeTopics(dir, layer.map((topic) => ({ ...topic, dropped: [], placed: new Map() })), new Date().toISOString().slice(0, 10));
  console.log(JSON.stringify({ rerendered: layer.length, files: files.length }));
  process.exit(0);
}
const result = await runDigest({
  dir,
  restricted: new Set(restrictedArg.split(',').filter(Boolean)),
  run,
  now: Date.now(),
  deadline: Date.now() + 90 * 60_000,
  concurrency: Number(concurrencyArg) || 3,
  full: mode === 'full',
});
await say(`result ${JSON.stringify({ ...result, files: result.files.length, changelog: result.changelog.length })}`);
console.log(JSON.stringify(result, null, 1));
