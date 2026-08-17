import { MilestonePlaceholder } from '@/components/milestone-placeholder';

export default function Page(): React.JSX.Element {
  return (
    <MilestonePlaceholder
      title="Archetypes"
      milestone="M4"
      description="Content archetypes clustered from your actual corpus, not invented by a model. Rename any of them; your names survive re-clustering."
    />
  );
}
