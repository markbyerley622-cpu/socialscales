"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, Loader2, RefreshCw } from "lucide-react";

import { approvePlanAction, createPlanAction } from "@/app/actions";
import { Button } from "@/components/ui/primitives";
import type { PlanStatus } from "@/lib/social-scales/contracts";

export function PlanActions({ planId, status }: { planId: string; status: PlanStatus }) {
  const router = useRouter();
  const [pending, setPending] = React.useState<"regenerate" | "approve" | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const regenerate = async () => {
    setPending("regenerate");
    setError(null);
    const result = await createPlanAction();
    setPending(null);
    if (!result.ok) setError(result.error);
    else router.refresh();
  };

  const approve = async () => {
    setPending("approve");
    setError(null);
    const result = await approvePlanAction(planId);
    setPending(null);
    if (!result.ok) setError(result.error);
    else router.refresh();
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {error ? (
        <span role="alert" className="text-[12px] text-danger">
          {error}
        </span>
      ) : null}

      <Button variant="secondary" size="sm" onClick={regenerate} disabled={pending !== null}>
        {pending === "regenerate" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        Regenerate plan
      </Button>

      {status === "ACTIVE" ? null : (
        <Button variant="primary" size="sm" onClick={approve} disabled={pending !== null}>
          {pending === "approve" ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCheck className="size-3.5" />}
          Approve plan
        </Button>
      )}
    </div>
  );
}
