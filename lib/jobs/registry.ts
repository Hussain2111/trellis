import { parsePayload, type JobContext, type JobHandler, type JobType } from './types';

const handlers = new Map<JobType, JobHandler>();

export function register<T extends JobType>(type: T, handler: JobHandler<T>): void {
  handlers.set(type, handler as JobHandler);
}

export function getHandler(type: string): JobHandler | undefined {
  return handlers.get(type as JobType);
}

export function registeredTypes(): JobType[] {
  return [...handlers.keys()];
}

/**
 * Handlers are registered here, one import per milestone. M0 ships only the
 * no-op so the queue can be exercised end to end before anything real exists.
 */
register('noop', async (ctx: JobContext<'noop'>) => {
  const { steps, sleepMs } = ctx.payload;
  const start = typeof ctx.checkpoint === 'number' ? ctx.checkpoint : 0;
  for (let i = start; i < steps; i++) {
    if (ctx.shouldStop()) {
      ctx.save({ checkpoint: i, label: `paused at step ${i}/${steps}` });
      return;
    }
    await new Promise((r) => setTimeout(r, sleepMs));
    ctx.save({ progress: (i + 1) / steps, label: `step ${i + 1}/${steps}`, checkpoint: i + 1 });
  }
});

export { parsePayload };
