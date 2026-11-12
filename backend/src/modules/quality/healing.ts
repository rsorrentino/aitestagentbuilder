/**
 * Keeping self-healed selectors.
 *
 * When the AI repairs a broken selector during a run, the result records it
 * (metadata.steps[].healedSelector). From there it can be:
 *   - reused for the rest of the run without another model call,
 *   - written back, on request (POST …/apply-healing) or automatically (agent config
 *     ai.auto_apply_healing = true): into the library element when the step used
 *     {{el.Name}}, into the library block the step came from, or else the test case.
 */

import type { TestStep } from '../../core/domain/test-case.js';

export interface HealedStep {
  stepId: number;
  from: string;
  to: string;
  /** The step came from a library block: the repair is saved there */
  block?: string;
  blockStepId?: number;
}

/** Healed steps recorded in a result's metadata. */
export function healedStepsOf(metadata: any): HealedStep[] {
  const steps: any[] = Array.isArray(metadata?.steps) ? metadata.steps : [];
  return steps
    .filter((s) => s && s.healedSelector && s.target && s.status === 'passed' && s.healedSelector !== s.target)
    .map((s) => ({ stepId: Number(s.stepId), from: String(s.target), to: String(s.healedSelector), ...(s.block ? { block: String(s.block), blockStepId: Number(s.blockStepId) } : {}) }));
}

/**
 * Replace the targets of the healed steps. A step is only changed when its
 * target is still the broken one (the test case may have been edited since).
 */
export function applyHealing(steps: TestStep[], healed: HealedStep[], only?: number[]): { steps: TestStep[]; applied: HealedStep[]; skipped: HealedStep[] } {
  const wanted = only?.length ? healed.filter((h) => only.includes(h.stepId)) : healed;
  const applied: HealedStep[] = [];
  const skipped: HealedStep[] = [];
  const next = steps.map((step) => {
    const h = wanted.find((x) => x.stepId === step.stepId);
    if (!h) return step;
    if (step.target !== h.from) {
      skipped.push(h);
      return step;
    }
    applied.push(h);
    return { ...step, target: h.to };
  });
  for (const h of wanted) if (!applied.includes(h) && !skipped.includes(h)) skipped.push(h);
  return { steps: next, applied, skipped };
}

/** Selectors healed earlier in the same run, reused without calling the model again. */
export class HealingCache {
  private map = new Map<string, string>();

  private key(target: string, url: string): string {
    let path = url;
    try {
      path = new URL(url).pathname;
    } catch {
      // keep as is
    }
    return `${path}\u0000${target}`;
  }

  get(target: string, url: string): string | undefined {
    return this.map.get(this.key(target, url));
  }

  set(target: string, url: string, healed: string): void {
    this.map.set(this.key(target, url), healed);
  }
}
