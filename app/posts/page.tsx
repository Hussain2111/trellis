import { MilestonePlaceholder } from '@/components/milestone-placeholder';

export default function Page(): React.JSX.Element {
  return (
    <MilestonePlaceholder
      title="Posts"
      milestone="M1"
      description="Every post I have scraped, with its features and the archetype it was assigned."
    />
  );
}
