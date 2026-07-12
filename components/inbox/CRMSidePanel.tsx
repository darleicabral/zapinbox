"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Tag, Receipt, Users, ArrowRight } from "@/lib/ui/icons";
import { createClient } from "@/lib/supabase/browser";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

interface Props {
  conversation: ConversationWithContact | null;
}

interface LeadRow {
  id: string;
  title: string;
  status: string;
  value_cents: number | null;
  currency: string | null;
  updated_at: string;
  description: string | null;
  custom_fields: Record<string, unknown> | null;
}

/** Rótulo legível a partir da chave snake_case do custom_fields. */
function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatFieldValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (value == null) return "—";
  return String(value);
}

interface OrderRow {
  id: string;
  external_id: string | null;
  status: string | null;
  total_cents: number | null;
  currency: string | null;
  created_at: string;
}

interface ActivityRow {
  id: string;
  type: string;
  source_module: string;
  performed_at: string;
  payload: Record<string, unknown> | null;
}

function formatMoney(cents: number | null, currency: string | null): string {
  if (cents == null) return "—";
  const cur = currency ?? "BRL";
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: cur }).format(
      cents / 100,
    );
  } catch {
    return `${(cents / 100).toFixed(2)} ${cur}`;
  }
}

function shortDate(iso: string): string {
  return format(new Date(iso), "dd/MM/yy HH:mm", { locale: ptBR });
}

export function CRMSidePanel({ conversation }: Props) {
  const contact = conversation?.contacts ?? null;
  const contactId = contact?.id ?? null;

  const [leads, setLeads] = useState<LeadRow[] | null>(null);
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [activities, setActivities] = useState<ActivityRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!contactId) {
      setLeads(null);
      setOrders(null);
      setActivities(null);
      return;
    }
    const supabase = createClient();
    let cancelled = false;
    setLoading(true);

    async function load() {
      const leadsP = supabase
        .from("crm_leads")
        .select("id, title, status, value_cents, currency, updated_at, description, custom_fields")
        .eq("contact_id", contactId)
        .order("updated_at", { ascending: false })
        .limit(3);

      const ordersP = supabase
        .from("orders")
        .select("id, external_id, status, total_cents, currency, created_at")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(3);

      const actsP = supabase
        .from("crm_lead_activities")
        .select("id, type, source_module, performed_at, payload")
        .eq("contact_id", contactId)
        .order("performed_at", { ascending: false })
        .limit(5);

      const [lr, or, ar] = await Promise.all([leadsP, ordersP, actsP]);

      if (cancelled) return;
      setLeads(lr.error ? [] : ((lr.data ?? []) as LeadRow[]));
      setOrders(or.error ? [] : ((or.data ?? []) as OrderRow[]));
      setActivities(ar.error ? [] : ((ar.data ?? []) as ActivityRow[]));
      setLoading(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  const tags = contact?.tags ?? [];
  const displayName =
    contact?.display_name?.trim() ||
    contact?.name?.trim() ||
    contact?.phone_number ||
    "—";

  const sectionsLoading = useMemo(
    () => loading || (leads === null && orders === null && activities === null),
    [loading, leads, orders, activities],
  );

  // Perfil qualificado (custom_fields) do lead aberto mais recente — capturado
  // pela IA via crm_save_lead_profile (C2).
  const profile = useMemo(() => {
    const withFields = (leads ?? []).find(
      (l) => l.custom_fields && Object.keys(l.custom_fields).length > 0,
    );
    if (!withFields?.custom_fields) return null;
    const entries = Object.entries(withFields.custom_fields).filter(
      ([, v]) => v != null && !(Array.isArray(v) && v.length === 0) && String(v).trim() !== "",
    );
    return { description: withFields.description, entries };
  }, [leads]);

  if (!conversation) {
    return (
      <aside className="flex h-full items-center justify-center border-l border-border p-4 text-center text-xs text-muted-foreground">
        Selecione uma conversa para ver detalhes do contato.
      </aside>
    );
  }

  return (
    <aside className="flex h-full flex-col gap-4 overflow-y-auto border-l border-border bg-background p-4">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Contato
        </h3>
        <Card className="mt-2 space-y-2 p-3 text-sm">
          <div className="font-medium">{displayName}</div>
          {contact?.phone_number && (
            <div className="text-xs text-muted-foreground">{contact.phone_number}</div>
          )}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tags.map((t) => (
                <Badge key={t} variant="secondary" className="h-4 px-1.5 text-[10px]">
                  {t}
                </Badge>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs">
              <Tag size={12} className="mr-1" weight="regular" aria-hidden /> Tag
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs">
              <Users size={12} className="mr-1" weight="regular" aria-hidden /> Lead
            </Button>
            {contactId && (
              <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
                <Link href={`/app/contacts/${contactId}`}>
                  Ver contato
                  <ArrowRight size={12} className="ml-1" weight="regular" aria-hidden />
                </Link>
              </Button>
            )}
          </div>
        </Card>
      </section>

      {profile && (profile.entries.length > 0 || profile.description) && (
        <>
          <Separator />
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Perfil do lead <span className="text-[10px] normal-case">· capturado pela IA</span>
            </h3>
            <Card className="mt-2 space-y-2 p-3 text-xs">
              {profile.description && (
                <p className="text-muted-foreground">{profile.description}</p>
              )}
              {profile.entries.length > 0 && (
                <dl className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-3 gap-y-1">
                  {profile.entries.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="truncate text-muted-foreground">{humanizeKey(k)}</dt>
                      <dd className="font-medium">{formatFieldValue(v)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </Card>
          </section>
        </>
      )}

      <Separator />

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Leads recentes
        </h3>
        {sectionsLoading ? (
          <Skeleton className="mt-2 h-14 w-full" />
        ) : leads && leads.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {leads.map((l) => (
              <li
                key={l.id}
                className="flex items-center justify-between rounded-md border border-border p-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{l.title}</div>
                  <div className="text-muted-foreground">
                    {l.status} · {formatMoney(l.value_cents, l.currency)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">Sem leads.</p>
        )}
      </section>

      <Separator />

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Pedidos recentes
        </h3>
        {sectionsLoading ? (
          <Skeleton className="mt-2 h-14 w-full" />
        ) : orders && orders.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {orders.map((o) => (
              <li
                key={o.id}
                className="flex items-center justify-between rounded-md border border-border p-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1 truncate font-medium">
                    <Receipt size={11} weight="regular" aria-hidden />
                    {o.external_id ?? o.id.slice(0, 8)}
                  </div>
                  <div className="text-muted-foreground">
                    {o.status ?? "—"} · {formatMoney(o.total_cents, o.currency)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">Sem pedidos.</p>
        )}
      </section>

      <Separator />

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Atividade
        </h3>
        {sectionsLoading ? (
          <Skeleton className="mt-2 h-14 w-full" />
        ) : activities && activities.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {activities.map((a) => (
              <li key={a.id} className="rounded-md border border-border p-2 text-xs">
                <div className="font-medium">{a.type}</div>
                <div className="text-muted-foreground">
                  {a.source_module} · {shortDate(a.performed_at)}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">Sem atividade.</p>
        )}
      </section>
    </aside>
  );
}
