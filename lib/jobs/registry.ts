import type { JobContext, JobHandler, JobType } from './types';

/**
 * One entry per job type. Handlers are added stage by stage as each part of
 * the pipeline is built — see the build order in AGENTS.md / the project spec.
 */
type HandlerMap = { [T in JobType]?: JobHandler<T> };

const handlers: HandlerMap = {
  noop: async (ctx: JobContext<'noop'>) => {
    for (let i = 0; i < ctx.payload.steps; i++) {
      await ctx.save({
        progress: (i + 1) / ctx.payload.steps,
        label: `step ${i + 1}/${ctx.payload.steps}`,
      });
    }
  },
};

export function getHandler<T extends JobType>(type: T): JobHandler<T> | undefined {
  return handlers[type];
}

export function registerHandler<T extends JobType>(type: T, handler: JobHandler<T>): void {
  (handlers as Record<JobType, JobHandler>)[type] = handler as JobHandler;
}
