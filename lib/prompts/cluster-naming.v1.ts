import { z } from 'zod';
import type { Prompt } from './index';

/**
 * One call names every cluster. The clusters already exist — this is only
 * putting human words on them, which is why it fits comfortably in one request
 * even with twenty clusters.
 */

export const clusterNamesSchema = z.object({
  clusters: z.array(
    z.object({
      cluster_id: z.number().int(),
      name: z.string().min(2).max(40),
      description: z.string().min(10).max(200),
    }),
  ),
});

export type ClusterNames = z.infer<typeof clusterNamesSchema>;

export interface ClusterNamingVars {
  niche: string;
  clusters: { clusterId: number; size: number; examples: string[] }[];
}

const SYSTEM = `You name content archetypes for a social-media coach.

An archetype is a recurring *kind* of post, named the way a creator would say it out loud: "secret settings tip", "myth-busting", "day in the life". Not a genre label, not a marketing category.

Rules:
- 2-4 words. Lowercase unless a proper noun.
- Name what the post DOES, not what it is about.
- Every name must be distinguishable from every other name in the same batch. If two clusters look alike, find the thing that separates them and name that.
- The description is one sentence explaining what the posts in the cluster have in common.
- Return JSON only.`;

export const clusterNaming: Prompt<ClusterNamingVars, ClusterNames> = {
  id: 'cluster-naming',
  version: 1,
  tier: 'A',
  system: SYSTEM,
  schema: clusterNamesSchema,
  render: (vars) => {
    const blocks = vars.clusters
      .map(
        (c) =>
          `Cluster ${c.clusterId} (${c.size} posts):\n` +
          c.examples.map((e) => `  - ${e.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n'),
      )
      .join('\n\n');

    return [
      `Niche: ${vars.niche || 'general Instagram content'}`,
      '',
      `Below are ${vars.clusters.length} clusters of post hooks, each shown with the examples closest to its centre.`,
      'Name each one.',
      '',
      blocks,
      '',
      `Return {"clusters":[{"cluster_id":N,"name":"...","description":"..."}]} with exactly ${vars.clusters.length} entries, one per cluster id above.`,
    ].join('\n');
  },
};

/**
 * Tier B variant. Only ever used as a degraded fallback, and only one cluster
 * at a time so the prompt stays inside the local ceiling. Expect worse names.
 */
export const clusterNamingLocal: Prompt<
  { examples: string[] },
  { name: string; description: string }
> = {
  id: 'cluster-naming-local',
  version: 1,
  tier: 'B',
  system: 'Name the pattern in 2-4 lowercase words. JSON only.',
  schema: z.object({ name: z.string().max(40), description: z.string().max(120) }),
  render: (vars) =>
    `Posts:\n${vars.examples.slice(0, 5).map((e) => `- ${e.slice(0, 80)}`).join('\n')}\n\nReturn {"name":"...","description":"..."}`,
};
