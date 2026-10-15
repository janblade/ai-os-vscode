import { createHash } from 'node:crypto';
import { missing, readText } from './files';

export class ContextChangedError extends Error {
  constructor(readonly sources: string[]) {
    super(`Run context changed: ${sources.join(', ')}. Execution was interrupted to avoid stale instructions. Review the saved files, then recover the run with current context. File changes do not establish approval or completion.`);
    this.name = 'ContextChangedError';
  }
}

/** Compare only the source files actually supplied to this agent, using its original checksums. */
export function memoryCheck(root: string, sources: { source: string; sha256: string }[]): () => Promise<void> {
  return async () => {
    const changed: string[] = [];
    for (const source of sources) {
      try {
        const content = await readText(root, source.source);
        if (createHash('sha256').update(content).digest('hex') !== source.sha256) changed.push(source.source);
      } catch (error) { if (!missing(error)) throw error; changed.push(source.source); }
    }
    if (changed.length) throw new ContextChangedError(changed);
  };
}
