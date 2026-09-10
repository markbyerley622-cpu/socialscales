"use client";

import * as React from "react";

import { Button, ErrorState, LinkButton } from "@/components/ui/primitives";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[social-scales] route error", error);
  }, [error]);

  return (
    <ErrorState
      title="This screen could not load"
      detail={
        error.message ||
        "The configured data source did not return what the UI expected. Check SOCIAL_SCALES_DATA_MODE and the backend URL."
      }
      action={
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" onClick={reset}>
            Try again
          </Button>
          <LinkButton href="/dashboard" size="sm" variant="secondary">
            Back to dashboard
          </LinkButton>
        </div>
      }
    />
  );
}
