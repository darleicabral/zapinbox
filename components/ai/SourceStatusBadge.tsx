"use client";
import { Badge } from "@/components/ui/badge";

interface Props {
  status: string | null;
}

type Variant = "default" | "neutral" | "success" | "warning" | "error" | "info";

function map(status: string | null): { label: string; variant: Variant } {
  switch (status) {
    case "ready":
      return { label: "Pronto", variant: "success" };
    case "pending":
    case "indexing":
      return { label: "Indexando", variant: "info" };
    case "partial":
      return { label: "Parcial", variant: "warning" };
    case "failed":
      return { label: "Falhou", variant: "error" };
    case "archived":
      return { label: "Arquivado", variant: "neutral" };
    default:
      return { label: "—", variant: "neutral" };
  }
}

export function SourceStatusBadge({ status }: Props) {
  const { label, variant } = map(status);
  return <Badge variant={variant}>{label}</Badge>;
}
