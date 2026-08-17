import { MilestonePlaceholder } from '@/components/milestone-placeholder';

export default function Page(): React.JSX.Element {
  return (
    <MilestonePlaceholder
      title="Calendar"
      milestone="M10"
      description="What is scheduled, what published, and what failed."
    />
  );
}
