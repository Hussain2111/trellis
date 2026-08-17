import type { ProviderDescriptor } from './types';

export class PaidProviderError extends Error {
  readonly provider: string;
  constructor(descriptor: ProviderDescriptor) {
    super(
      `Refusing to instantiate paid provider "${descriptor.id}" (${descriptor.kind}): ` +
        `${descriptor.costNote}. ALLOW_PAID_PROVIDERS is false. ` +
        `This build is meant to cost $0/month — set ALLOW_PAID_PROVIDERS=true only if you ` +
        `have decided to spend money, and never as a workaround for an exhausted free tier.`,
    );
    this.name = 'PaidProviderError';
    this.provider = descriptor.id;
  }
}

/**
 * Call this in the constructor of any provider that can bill. It throws — there
 * is no silent fallback to a billable API, and no "just this once" path.
 */
export function assertProviderAllowed(descriptor: ProviderDescriptor): void {
  if (!descriptor.costsMoney) return;
  const allowed = ['1', 'true', 'yes', 'on'].includes(
    (process.env.ALLOW_PAID_PROVIDERS ?? 'false').toLowerCase(),
  );
  if (!allowed) throw new PaidProviderError(descriptor);
}
