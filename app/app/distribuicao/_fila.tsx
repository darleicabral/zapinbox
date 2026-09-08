"use client";
/**
 * A fila de lead SEM CORRETOR, com distribuição em lote.
 *
 * Pedido do Darlei (08/09/2026): "não posso deixar esses leads parados. Preciso
 * distribuí-los aos corretores e enviar a notificação a eles."
 *
 * Por que a seleção é EXPLÍCITA e não um "distribuir tudo" de um clique: cada
 * item manda um WhatsApp pro corretor. Distribuir 46 num botão é o incidente de
 * 01/09/2026 de novo (116 mensagens em 5 minutos). Então o padrão é nada
 * marcado, e o botão diz em números o que vai acontecer.
 */
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  useDistribuirLeads,
  useFilaSemCorretor,
  type JanelaFila,
} from "@/hooks/attendance/useFilaSemCorretor";
import type { LeadSemCorretor } from "@/lib/attendance/fila-parada";
import type { LinhaCorretor } from "@/lib/reports/distribuicao";

const JANELAS: { v: JanelaFila; label: string }[] = [
  { v: 1, label: "24h" },
  { v: 7, label: "7 dias" },
  { v: 30, label: "30 dias" },
];

/** "há 3 h", "há 2 d" — o quanto o lead esfriou, sem precisar fazer conta. */
function esfriouHa(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `há ${min} min`;
  if (min < 60 * 24) return `há ${Math.round(min / 60)} h`;
  return `há ${Math.round(min / (60 * 24))} d`;
}

function LinhaLead({
  lead,
  marcado,
  onMarcar,
}: {
  lead: LeadSemCorretor;
  marcado: boolean;
  onMarcar: (id: string, v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 border-b border-border/60 py-3 last:border-0">
      <input
        type="checkbox"
        className="mt-1 size-4 shrink-0"
        checked={marcado}
        onChange={(e) => onMarcar(lead.conversationId, e.target.checked)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <p className="truncate text-sm font-medium">{lead.nome}</p>
          {lead.leadEsperando && (
            <span className="rounded bg-warning-bg px-1.5 py-0.5 text-xs text-warning-fg">
              esperando resposta
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {lead.mensagensDoLead} mensagens {"·"} {esfriouHa(lead.ultimaEntradaEm)}
          </span>
        </div>
        {lead.ultimaFala && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {"“"}
            {lead.ultimaFala}
            {"”"}
          </p>
        )}
      </div>
    </label>
  );
}

export function FilaSemCorretor({ corretores }: { corretores: LinhaCorretor[] }) {
  const [dias, setDias] = useState<JanelaFila>(7);
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [alvo, setAlvo] = useState<string>("rodizio");
  const { data, isLoading, isFetching } = useFilaSemCorretor(dias);
  const distribuir = useDistribuirLeads();

  // useMemo no fallback: `?? []` cria array nova a cada render e faria o
  // useMemo de baixo recalcular sempre (o lint reclama disso, com razão).
  const leads = useMemo(() => data?.leads ?? [], [data?.leads]);
  // O teto do servidor é 25 por chamada; a tela precisa dizer isso ANTES do
  // clique, senão o gestor marca 46 e leva um 422 sem entender.
  const TETO = 25;
  const selecionados = useMemo(
    () => leads.filter((l) => marcados.has(l.conversationId)),
    [leads, marcados],
  );
  const passouDoTeto = selecionados.length > TETO;

  function marcar(id: string, v: boolean) {
    setMarcados((atual) => {
      const proximo = new Set(atual);
      if (v) proximo.add(id);
      else proximo.delete(id);
      return proximo;
    });
  }

  function marcarTodos(v: boolean) {
    setMarcados(v ? new Set(leads.slice(0, TETO).map((l) => l.conversationId)) : new Set());
  }

  async function enviar() {
    const ids = selecionados.slice(0, TETO).map((l) => l.conversationId);
    if (ids.length === 0) return;
    await distribuir.mutateAsync({
      conversationIds: ids,
      userId: alvo === "rodizio" ? undefined : alvo,
    });
    setMarcados(new Set());
  }

  const podeAtender = corretores.filter((c) => !c.semTelefone);

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Leads sem corretor</h2>
          <p className="text-xs text-muted-foreground">
            Conversaram e ninguém foi avisado. Marque e distribua: cada um recebe o aviso no
            WhatsApp.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {JANELAS.map((j) => (
            <Button
              key={j.v}
              size="sm"
              variant={dias === j.v ? "default" : "outline"}
              onClick={() => {
                setDias(j.v);
                setMarcados(new Set());
              }}
            >
              {j.label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <p className="py-6 text-sm text-muted-foreground">Carregando…</p>
      ) : leads.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">
          Nenhum lead parado nessa janela. Todo mundo que conversou tem corretor.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
            <div className="flex items-center gap-3">
              <Button size="sm" variant="ghost" onClick={() => marcarTodos(true)}>
                Marcar {Math.min(leads.length, TETO)}
              </Button>
              {marcados.size > 0 && (
                <Button size="sm" variant="ghost" onClick={() => marcarTodos(false)}>
                  Limpar
                </Button>
              )}
              <span className="text-xs text-muted-foreground">
                {leads.length} parado(s){isFetching ? " · atualizando…" : ""}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="ds-input h-8 text-sm"
                value={alvo}
                onChange={(e) => setAlvo(e.target.value)}
              >
                <option value="rodizio">Rodízio (divide entre a equipe)</option>
                {podeAtender.map((c) => (
                  <option key={c.userId} value={c.userId}>
                    {c.nome}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={selecionados.length === 0 || distribuir.isPending}
                onClick={() => void enviar()}
              >
                {distribuir.isPending
                  ? "Enviando…"
                  : `Distribuir e avisar (${Math.min(selecionados.length, TETO)})`}
              </Button>
            </div>
          </div>

          {passouDoTeto && (
            <p className="mt-2 text-xs text-warning-fg">
              Marcados {selecionados.length}, e o envio vai até {TETO} por vez. Os primeiros {TETO}{" "}
              da lista saem agora; repita pro resto.
            </p>
          )}

          {distribuir.data && (
            <p className="mt-2 text-xs text-muted-foreground">
              Último envio: {distribuir.data.distribuidos.length} distribuído(s)
              {distribuir.data.distribuidos.filter((d) => !d.notified).length > 0 &&
                `, ${distribuir.data.distribuidos.filter((d) => !d.notified).length} sem aviso no WhatsApp (corretor sem número cadastrado)`}
              {distribuir.data.pulados.length > 0 &&
                `, ${distribuir.data.pulados.length} pulado(s) por já ter dono`}
              .
            </p>
          )}

          <div className="mt-1">
            {leads.map((l) => (
              <LinhaLead
                key={l.conversationId}
                lead={l}
                marcado={marcados.has(l.conversationId)}
                onMarcar={marcar}
              />
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
