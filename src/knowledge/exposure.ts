import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import { localDayKey } from '../runtime/usage-ledger';

interface ExposureData {
  version: 1;
  /** Times each note (`<scope>/<topic>`) was listed in a full knowledge block sent to a conversation. */
  counts: Record<string, number>;
  /** The day {@link frozen} was taken. */
  day?: string;
  /** `counts` as of the start of {@link day}: what the index ranks by all that day. */
  frozen?: Record<string, number>;
}

/**
 * How often each note has been put in front of the agent: the index's
 * exploration share lists the least shown first, so every note gets its turn.
 *
 * The index ranks by the counts as they stood at the start of the day, not as
 * they are now. A count that moved with every block sent would change the
 * index, hence its version, on every message, and a conversation would get the
 * full block again each time instead of a stub.
 */
export class NoteExposure {
  private data: ExposureData = { version: 1, counts: {} };
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly dayKey: (at: number) => string = localDayKey,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Partial<ExposureData>;
      if (raw?.version === 1 && raw.counts && typeof raw.counts === 'object') {
        this.data = {
          version: 1,
          counts: raw.counts,
          ...(typeof raw.day === 'string' && raw.frozen ? { day: raw.day, frozen: raw.frozen } : {}),
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.warn('knowledge', 'exposure-load-failed', { err: String(err) });
    }
  }

  /** Each note's count as of the start of the day `now` falls in. */
  asOf(now: number): (name: string) => number {
    const day = this.dayKey(now);
    if (this.data.day !== day || !this.data.frozen) {
      this.data.day = day;
      this.data.frozen = { ...this.data.counts };
      this.persist();
    }
    const frozen = this.data.frozen;
    return (name) => frozen[name] ?? 0;
  }

  /** These notes were just sent to a conversation in a full knowledge block. */
  record(names: readonly string[]): void {
    if (names.length === 0) return;
    for (const name of new Set(names)) this.data.counts[name] = (this.data.counts[name] ?? 0) + 1;
    this.persist();
  }

  private persist(): void {
    const snapshot = JSON.stringify(this.data);
    this.saving = this.saving
      .then(() => writeFileAtomic(this.path, snapshot))
      .catch((err: unknown) => log.warn('knowledge', 'exposure-persist-failed', { err: String(err) }));
  }

  /** Resolves once every write queued so far has landed (tests). */
  flush(): Promise<void> {
    return this.saving;
  }
}
