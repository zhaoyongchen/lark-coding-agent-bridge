import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NoteExposure } from '../../../src/knowledge/exposure.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'note-exposure-'));
  dirs.push(dir);
  return join(dir, 'note-exposure.json');
}

describe('NoteExposure', () => {
  const dayOf = (at: number) => `day-${Math.floor(at / 100)}`;

  it('ranks by the counts as they stood at the start of the day, so the index holds still all day', async () => {
    const exposure = new NoteExposure(await tempFile(), dayOf);
    expect(exposure.asOf(0)('oc_1/a')).toBe(0);
    exposure.record(['oc_1/a', 'oc_1/a', 'external/b']);
    expect(exposure.asOf(50)('oc_1/a')).toBe(0);
    expect(exposure.asOf(150)('oc_1/a')).toBe(1);
    expect(exposure.asOf(150)('external/b')).toBe(1);
    await exposure.flush();
  });

  it('keeps the counts and the day it froze across a restart', async () => {
    const file = await tempFile();
    const first = new NoteExposure(file, dayOf);
    first.asOf(0);
    first.record(['oc_1/a']);
    await first.flush();
    expect(JSON.parse(await readFile(file, 'utf8')).counts).toEqual({ 'oc_1/a': 1 });
    const second = new NoteExposure(file, dayOf);
    await second.load();
    expect(second.asOf(10)('oc_1/a')).toBe(0);
    expect(second.asOf(100)('oc_1/a')).toBe(1);
    await second.flush();
  });

  it('starts empty when there is no file yet', async () => {
    const exposure = new NoteExposure(await tempFile(), dayOf);
    await exposure.load();
    expect(exposure.asOf(0)('x/y')).toBe(0);
    await exposure.flush();
  });
});
