import { MilestonePlaceholder } from '@/components/milestone-placeholder';

export default function Page(): React.JSX.Element {
  return (
    <MilestonePlaceholder
      title="Competitors"
      milestone="M3"
      description="The accounts I benchmark against. Manually curated — hashtag discovery burns credits guessing at something you already know."
    />
  );
}
