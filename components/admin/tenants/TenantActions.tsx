"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SuspendDialog } from "./SuspendDialog";
import { ImpersonateButton } from "@/components/admin/ImpersonateButton";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TenantActionsProps {
  organizationId: string;
  status: "active" | "suspended" | "onboarding" | "redacted";
  displayName: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TenantActions({
  organizationId,
  status,
  displayName,
}: TenantActionsProps) {
  const [suspendOpen, setSuspendOpen] = useState(false);

  const canSuspend = status === "active" || status === "onboarding";
  const isSuspended = status === "suspended";
  const isRedacted = status === "redacted";

  function handleReactivate() {
    // STUB — Wave 8 (S-11.08) implementará reactivation real
    toast.info("Reativação disponível em S-11.08", {
      description: "O endpoint de reativação será implementado na Wave 8.",
    });
  }

  return (
    <>
      <div className="rounded-lg border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Ações
        </h2>

        {/* Impersonate (S-11.07) */}
        <ImpersonateButton
          organizationId={organizationId}
          displayName={displayName}
          disabled={isRedacted}
          disabledReason={
            isRedacted ? "Tenant redigido — ação não disponível" : undefined
          }
        />

        {/* Suspend / Reactivate */}
        {canSuspend && (
          <Button
            className="w-full"
            variant="destructive"
            onClick={() => setSuspendOpen(true)}
            aria-label="Suspender tenant"
          >
            Suspender tenant
          </Button>
        )}

        {isSuspended && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={handleReactivate}
                  aria-label="Reativar tenant (disponível em S-11.08)"
                >
                  Reativar tenant
                </Button>
              </TooltipTrigger>
              <TooltipContent>Disponível em S-11.08 (Wave 8)</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        {isRedacted && (
          <p className="text-xs text-muted-foreground text-center py-2">
            Tenant redigido — ações de gestão não disponíveis.
          </p>
        )}
      </div>

      <SuspendDialog
        open={suspendOpen}
        onClose={() => setSuspendOpen(false)}
        organizationId={organizationId}
      />
    </>
  );
}
