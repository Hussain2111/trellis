'use client';

import { useRef, useState, useTransition, type ReactNode } from 'react';

/**
 * A form whose server action returns `{ error }` rather than throwing.
 *
 * Next's plain `<form action>` requires a void-returning action, which would
 * mean swallowing validation errors — and the errors here are the useful part
 * ("that would cost more credits than you have left").
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = true,
}: {
  action: (formData: FormData) => Promise<{ error?: string } | void>;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      ref={ref}
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setError(null);
        start(async () => {
          const result = await action(data);
          if (result && 'error' in result && result.error) setError(result.error);
          else if (resetOnSuccess) ref.current?.reset();
        });
      }}
    >
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
      {error ? <p className="mt-2 basis-full text-[12px] text-negative">{error}</p> : null}
    </form>
  );
}
