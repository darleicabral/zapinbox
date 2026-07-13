"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash } from "@/lib/ui/icons";
import { updateAtendimento } from "@/app/actions/settings/updateAtendimento";
import {
  atendimentoSchema,
  type AtendimentoInput,
  type BusinessWindowInput,
  type FollowupStepInput,
} from "@/lib/schemas/atendimento";

interface Props {
  initial: AtendimentoInput;
}

const TIMEZONES = [
  "America/Sao_Paulo",
  "America/Manaus",
  "America/Belem",
  "America/Recife",
  "America/Fortaleza",
  "UTC",
];

const DAY_LABELS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function newWindow(): BusinessWindowInput {
  return { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };
}

function newStep(): FollowupStepInput {
  return { after_minutes: 60, message: "", discard: false };
}

export function AtendimentoForm({ initial }: Props) {
  const [timezone, setTimezone] = useState(initial.business_hours?.timezone ?? "America/Sao_Paulo");
  const [windows, setWindows] = useState<BusinessWindowInput[]>(
    initial.business_hours?.windows ?? [],
  );
  const [attendance, setAttendance] = useState(initial.attendance);
  const [followup, setFollowup] = useState(initial.followup);
  const [isPending, startTransition] = useTransition();

  function setWindowAt(i: number, patch: Partial<BusinessWindowInput>) {
    setWindows((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  }

  function toggleDay(i: number, day: number) {
    setWindows((ws) =>
      ws.map((w, j) => {
        if (j !== i) return w;
        const days = w.days.includes(day)
          ? w.days.filter((d) => d !== day)
          : [...w.days, day].sort();
        return { ...w, days };
      }),
    );
  }

  function setStepAt(i: number, patch: Partial<FollowupStepInput>) {
    setFollowup((f) => ({
      ...f,
      steps: f.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)),
    }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const candidate: AtendimentoInput = {
      business_hours: windows.length > 0 ? { timezone, windows } : null,
      attendance,
      followup,
    };
    const parsed = atendimentoSchema.safeParse(candidate);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      toast.error(first ? `Dados inválidos: ${first.message}` : "Dados inválidos.");
      return;
    }
    startTransition(async () => {
      const r = await updateAtendimento(parsed.data);
      if (r.ok) toast.success("Configurações de atendimento salvas.");
      else toast.error(`Erro ao salvar: ${r.error}`);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-3xl space-y-6 pb-10">
      {/* ── Expediente ─────────────────────────────────────────────── */}
      <Card className="space-y-4 p-6">
        <div>
          <h2 className="text-base font-semibold">Expediente</h2>
          <p className="text-sm text-muted-foreground">
            Fora dessas janelas, o reengajamento automático e os prazos do rodízio ficam
            pausados. Sem janelas = funciona 24/7.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Fuso horário</Label>
          <Select value={timezone} onValueChange={setTimezone}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIMEZONES.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-3">
          {windows.map((w, i) => (
            <div
              key={i}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3"
            >
              <div className="flex gap-1">
                {DAY_LABELS.map((label, day) => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleDay(i, day)}
                    className={
                      w.days.includes(day)
                        ? "h-7 rounded px-2 text-xs font-medium bg-accent text-accent-foreground"
                        : "h-7 rounded px-2 text-xs text-muted-foreground border border-border hover:bg-surface-muted"
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="time"
                  className="w-28"
                  value={w.start}
                  onChange={(e) => setWindowAt(i, { start: e.target.value })}
                />
                <span className="text-xs text-muted-foreground">até</span>
                <Input
                  type="time"
                  className="w-28"
                  value={w.end}
                  onChange={(e) => setWindowAt(i, { end: e.target.value })}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-7 px-2 text-xs text-muted-foreground"
                onClick={() => setWindows((ws) => ws.filter((_, j) => j !== i))}
              >
                <Trash size={13} weight="regular" aria-hidden />
                <span className="sr-only">Remover janela</span>
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setWindows((ws) => [...ws, newWindow()])}
          >
            + Adicionar janela
          </Button>
        </div>
      </Card>

      {/* ── Rodízio & SLA ──────────────────────────────────────────── */}
      <Card className="space-y-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Rodízio & prazos (SLA)</h2>
            <p className="text-sm text-muted-foreground">
              Distribui leads entre a equipe online e cobra prazos de resposta.
            </p>
          </div>
          <Switch
            checked={attendance.enabled}
            onCheckedChange={(v) => setAttendance((a) => ({ ...a, enabled: v }))}
            aria-label="Ativar rodízio e SLA"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="claim-sla">Assumir em (min)</Label>
            <Input
              id="claim-sla"
              type="number"
              min={1}
              max={1440}
              value={attendance.claim_sla_minutes}
              onChange={(e) =>
                setAttendance((a) => ({ ...a, claim_sla_minutes: Number(e.target.value) }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Sem &quot;eu cuido&quot; nesse prazo → passa ao próximo.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="fr-sla">1ª resposta em (min)</Label>
            <Input
              id="fr-sla"
              type="number"
              min={1}
              max={1440}
              value={attendance.first_response_sla_minutes}
              onChange={(e) =>
                setAttendance((a) => ({
                  ...a,
                  first_response_sla_minutes: Number(e.target.value),
                }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Assumiu e não respondeu → alerta o gestor.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="max-passes">Repasses até o gestor</Label>
            <Input
              id="max-passes"
              type="number"
              min={1}
              max={10}
              value={attendance.max_passes}
              onChange={(e) =>
                setAttendance((a) => ({ ...a, max_passes: Number(e.target.value) }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Depois disso o lead cai pro gestor, com alerta.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border border-border p-3">
          <div>
            <div className="text-sm font-medium">Avisar corretor por WhatsApp</div>
            <p className="text-xs text-muted-foreground">
              Ao atribuir/repassar um lead, envia resumo + link pro WhatsApp cadastrado na
              tela Equipe.
            </p>
          </div>
          <Switch
            checked={attendance.notify_whatsapp}
            onCheckedChange={(v) => setAttendance((a) => ({ ...a, notify_whatsapp: v }))}
            aria-label="Avisar corretor por WhatsApp"
          />
        </div>
      </Card>

      {/* ── Follow-up ──────────────────────────────────────────────── */}
      <Card className="space-y-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Reengajamento automático</h2>
            <p className="text-sm text-muted-foreground">
              Mensagens enviadas quando o cliente para de responder (contadas da última
              mensagem dele). Use {"{nome}"} para o primeiro nome. Só roda com o bot ainda
              no comando da conversa.
            </p>
          </div>
          <Switch
            checked={followup.enabled}
            onCheckedChange={(v) => setFollowup((f) => ({ ...f, enabled: v }))}
            aria-label="Ativar reengajamento"
          />
        </div>

        <div className="space-y-3">
          {followup.steps.map((s, i) => (
            <div key={i} className="space-y-2 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor={`step-min-${i}`} className="text-xs text-muted-foreground">
                    Após
                  </Label>
                  <Input
                    id={`step-min-${i}`}
                    type="number"
                    min={1}
                    max={43200}
                    className="w-24"
                    value={s.after_minutes}
                    onChange={(e) => setStepAt(i, { after_minutes: Number(e.target.value) })}
                  />
                  <span className="text-xs text-muted-foreground">min de silêncio</span>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={s.discard ?? false}
                    onCheckedChange={(v) => setStepAt(i, { discard: v })}
                    aria-label="Etapa de descarte"
                  />
                  descarte (move pra Perdido e encerra)
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-7 px-2 text-xs text-muted-foreground"
                  onClick={() =>
                    setFollowup((f) => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))
                  }
                >
                  <Trash size={13} weight="regular" aria-hidden />
                  <span className="sr-only">Remover etapa</span>
                </Button>
              </div>
              <Textarea
                value={s.message}
                placeholder="Ex.: Oi {nome}! Ficou alguma dúvida sobre os imóveis que te mandei?"
                maxLength={1000}
                rows={2}
                onChange={(e) => setStepAt(i, { message: e.target.value })}
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setFollowup((f) => ({ ...f, steps: [...f.steps, newStep()] }))}
            disabled={followup.steps.length >= 10}
          >
            + Adicionar etapa
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Label htmlFor="throttle" className="text-xs text-muted-foreground">
            Pausa entre envios no mesmo minuto (anti-bloqueio)
          </Label>
          <Input
            id="throttle"
            type="number"
            min={0}
            max={60}
            className="w-20"
            value={followup.throttle_seconds}
            onChange={(e) =>
              setFollowup((f) => ({ ...f, throttle_seconds: Number(e.target.value) }))
            }
          />
          <span className="text-xs text-muted-foreground">seg</span>
        </div>
      </Card>

      <Button type="submit" disabled={isPending}>
        {isPending ? "Salvando…" : "Salvar configurações"}
      </Button>
    </form>
  );
}
