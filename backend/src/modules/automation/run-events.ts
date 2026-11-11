/**
 * In-process bus for run lifecycle events (notifications, CI wait mode).
 */

import { EventEmitter } from 'events';
import type { TestRun } from '../../core/domain/run.js';

export type RunFinishedEvent = { run: TestRun };

class RunEventBus extends EventEmitter {
  emitFinished(run: TestRun): void {
    this.emit('run.finished', { run } satisfies RunFinishedEvent);
  }

  /** Resolves with the finished run, or null on timeout. */
  waitForFinish(runId: string, timeoutMs: number): Promise<TestRun | null> {
    return new Promise((resolve) => {
      const onFinish = ({ run }: RunFinishedEvent) => {
        if (run.id !== runId) return;
        cleanup();
        resolve(run);
      };
      const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('run.finished', onFinish);
      };
      this.on('run.finished', onFinish);
    });
  }
}

export const runEvents = new RunEventBus();
runEvents.setMaxListeners(200);
