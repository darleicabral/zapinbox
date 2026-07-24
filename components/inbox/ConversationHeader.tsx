"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Phone, ArrowRight } from "@/lib/ui/icons";
import { useAuth, useActiveOrg } from "@/hooks/auth/AuthProvider";
import { hasPosvendaModule } from "@/lib/modules";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useReleaseConversation } from "@/hooks/inbox/useReleaseConversation";
import { useCloseConversation } from "@/hooks/inbox/useCloseConversation";
import { useOpenLead } from "@/hooks/inbox/useOpenLead";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

interface Props {
  conversation: ConversationWithContact;
}

const STATUS_LABEL: Record<string, string> = {
  open: "Aberta",
  claimed: "Em atendimento",
  ai_handling: "IA atendendo",
  closed: "Fechada",
  archived: "Arquivada",
};

/** Sinalização de triagem gravada pela IA em conversations.metadata.triagem. */
interface Triagem {
  assunto?: string;
  categoria_sugerida?: string;
  nivel_sugerido?: "Verde" | "Amarelo" | "Vermelho";
  resumo?: string;
}
const NIVEL_STYLE: Record<string, string> = {
  Vermelho: "border-error/40 bg-error-bg text-error-fg",
  Amarelo: "border-warning/40 bg-warning-bg text-warning-fg",
  Verde: "border-success/40 bg-success-bg text-success-fg",
};

export function ConversationHeader({ conversation }: Props) {
  const { user } = useAuth();
  const activeOrg = useActiveOrg();
  const isPosvenda = hasPosvendaModule(activeOrg?.orgId);
  const router = useRouter();
  const claim = useClaimConversation();
  const release = useReleaseConversation();
  const close = useCloseConversation();
  const openLead = useOpenLead();

  const c = conversation.contacts ?? null;
  const displayName =
    c?.display_name?.trim() || c?.name?.trim() || c?.phone_number || "Sem nome";
  const phone = c?.phone_number ?? null;
  const status = conversation.status;
  const isMineAssigned = conversation.assigned_to_user_id === user.id;
  const isOpen = status === "open" || conversation.assigned_to_user_id == null;

  const triagem = (conversation as unknown as { metadata?: { triagem?: Triagem } }).metadata?.triagem;

  async function onOpenLead() {
    try {
      const res = await openLead.mutateAsync({ conversation_id: conversation.id });
      const info = res.data;
      if (info.reincidente) {
        toast.warning(
          `Cliente reincidente — abrindo o atendimento já existente${info.external_id ? ` (${info.external_id})` : ""}.`,
        );
      } else {
        toast.success("Atendimento aberto — confira a classificação sugerida.");
      }
      // Abre o card do atendimento direto no board (triagem pré-preenchida, editável).
      router.push(`/app/pipelines/${info.pipeline_id}?open=${info.lead_id}`);
    } catch {
      // erro já mostrado pelo hook
    }
  }

  return (
    <div className="flex flex-col border-b border-border bg-background">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{displayName}</h2>
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              {STATUS_LABEL[status] ?? status}
            </Badge>
          </div>
          {phone && (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              <Phone size={11} weight="regular" aria-hidden /> {phone}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {isPosvenda && (
            <Button
              size="sm"
              variant="default"
              disabled={openLead.isPending}
              onClick={onOpenLead}
            >
              {openLead.isPending ? "Abrindo…" : "Abrir atendimento"}
            </Button>
          )}
          {/* Assumir/Liberar só fazem sentido com vários atendentes disputando a
              fila. Em tenant de atendente único (pós-venda Itaville) some. */}
          {!isPosvenda && isOpen && (
            <Button
              size="sm"
              variant="outline"
              disabled={claim.isPending}
              onClick={() =>
                claim.mutate({
                  conversation_id: conversation.id,
                  expected_assignee: conversation.assigned_to_user_id,
                })
              }
            >
              Assumir
            </Button>
          )}
          {!isPosvenda && isMineAssigned && (
            <Button
              size="sm"
              variant="outline"
              disabled={release.isPending}
              onClick={() => release.mutate({ conversation_id: conversation.id })}
            >
              Liberar
            </Button>
          )}
          {status !== "closed" && status !== "archived" && (
            <Button
              size="sm"
              variant="outline"
              disabled={close.isPending}
              onClick={() => {
                if (confirm("Fechar esta conversa?")) {
                  close.mutate({ conversation_id: conversation.id });
                }
              }}
            >
              Fechar
            </Button>
          )}
          {c?.id && (
            <Button asChild size="sm" variant="ghost">
              <Link href={`/app/contacts/${c.id}`} className="flex items-center gap-1">
                Ver contato
                <ArrowRight size={12} weight="regular" aria-hidden />
              </Link>
            </Button>
          )}
        </div>
      </div>

      {/* Sinalização de triagem da IA (só sinaliza; a atendente decide abrir). */}
      {triagem?.assunto && (
        <div
          className={`mx-4 mb-3 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs ${
            triagem.nivel_sugerido ? NIVEL_STYLE[triagem.nivel_sugerido] : "border-border bg-surface-muted/40 text-text-muted"
          }`}
        >
          <span className="font-semibold uppercase tracking-wide">Triagem IA</span>
          <span className="font-medium">{triagem.assunto}</span>
          {triagem.nivel_sugerido && (
            <span className="rounded-full border border-current/30 px-1.5 py-0.5 text-[10px] font-semibold">
              {triagem.nivel_sugerido}
            </span>
          )}
          {triagem.resumo && <span className="w-full text-[11px] opacity-80">{triagem.resumo}</span>}
        </div>
      )}
    </div>
  );
}
