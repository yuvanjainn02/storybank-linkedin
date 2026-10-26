'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** Announce and focus a newly displayed server error after the DOM commits. */
export default function FocusedError({ message, children }: { message: string; children?: ReactNode }) {
  const summary = useRef<HTMLDivElement>(null);
  useEffect(() => { summary.current?.focus(); }, [message]);
  return <div ref={summary} tabIndex={-1} role="alert" className="sb-error"><span>{message}</span>{children}</div>;
}
