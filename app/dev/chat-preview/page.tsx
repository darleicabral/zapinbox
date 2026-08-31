import { notFound } from "next/navigation";
import type { Message } from "@/lib/types/messaging";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import { Paperclip, PaperPlaneTilt } from "@/lib/ui/icons";

/**
 * PRÉVIA DE DESIGN (dev-only) — Inbox no visual WhatsApp Web.
 * Não existe em produção (notFound). Serve só pra revisar o look com dados fake,
 * usando o MessageBubble real. Rota liberada em lib/auth/public-paths.
 */
export const dynamic = "force-static";

function mk(o: Partial<Message>): Message {
  return {
    id: o.id ?? Math.random().toString(36).slice(2),
    organization_id: "org",
    conversation_id: "conv",
    channel_session_id: "cs",
    contact_id: "c",
    external_id: null,
    type: o.type ?? "text",
    direction: o.direction ?? "inbound",
    status: o.status ?? "read",
    ack: 3,
    error_code: null,
    error_message: null,
    body: o.body ?? null,
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: o.sent_via ?? "user",
    sent_by_user_id: null,
    sent_at: o.sent_at ?? new Date().toISOString(),
    delivered_at: null,
    read_at: null,
    metadata: o.metadata ?? {},
    created_at: new Date().toISOString(),
  };
}

function at(h: number, m: number): string {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

const MESSAGES: Message[] = [
  mk({ direction: "inbound", body: "Oi! Vi um apartamento de vocês no Floramar, ainda tá disponível?", sent_at: at(9, 12) }),
  mk({ direction: "outbound", sent_via: "ai", status: "read", sent_at: at(9, 13), body: "Oi, Maria! 😊 Tenho sim. Você procura de 2 ou 3 quartos? E qual a faixa de preço?" }),
  mk({ direction: "inbound", body: "2 quartos, até uns 350 mil", sent_at: at(9, 15) }),
  mk({ direction: "inbound", body: "Pode ser financiado?", sent_at: at(9, 15) }),
  mk({ direction: "outbound", sent_via: "ai", status: "read", sent_at: at(9, 16), body: "Perfeito 👍 Tenho um de 2 quartos no Floramar por R$ 320.000, aceita financiamento pela Caixa. Quer que eu te mande as fotos e já veja uma visita?" }),
  mk({ direction: "inbound", sent_at: at(9, 18), body: "Quero sim!", metadata: { quoted: { author: "Consultor Avant", from_me: true, text: "Quer que eu te mande as fotos e já veja uma visita?" } } }),
  mk({ direction: "outbound", sent_via: "user", status: "delivered", sent_at: at(9, 25), body: "Oi Maria, aqui é o Robson, corretor da Avant. Consigo te levar lá no sábado às 10h, pode ser?" }),
];

const CONVERSATIONS = [
  { name: "Maria Silva", preview: "Quero sim!", time: "09:18", hue: 330, unread: 0, active: true },
  { name: "João Pereira", preview: "Bom dia, tem casa em Venda Nova?", time: "09:02", hue: 190, unread: 2, active: false },
  { name: "Ana Beatriz", preview: "Obrigada, vou pensar 🙏", time: "Ontem", hue: 95, unread: 0, active: false },
  { name: "Carlos Eduardo", preview: "Consigo pagar 40 mil de entrada", time: "Ontem", hue: 45, unread: 0, active: false },
  { name: "Fernanda Lima", preview: "Vocês trabalham com aluguel também?", time: "Seg", hue: 280, unread: 0, active: false },
];

function initials(name: string): string {
  const p = name.split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[p.length - 1]?.[0] ?? "")).toUpperCase();
}

export default function ChatPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <div className="grid h-screen w-full grid-cols-[360px_1fr] overflow-hidden bg-bg text-text">
      {/* ── Lista de conversas ── */}
      <div className="flex min-h-0 flex-col border-r border-border" style={{ background: "var(--wa-panel)" }}>
        <div className="flex h-14 items-center justify-between px-4" style={{ background: "var(--wa-bar)" }}>
          <span className="text-base font-semibold">Conversas</span>
        </div>
        <div className="px-3 py-2" style={{ background: "var(--wa-panel)" }}>
          <div className="rounded-lg px-3 py-1.5 text-xs text-text-subtle" style={{ background: "var(--wa-bar)" }}>
            Pesquisar ou começar nova conversa
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {CONVERSATIONS.map((c) => (
            <div
              key={c.name}
              className="flex cursor-pointer items-center gap-3 border-b border-border/60 px-3 py-3"
              style={c.active ? { background: "var(--wa-hover)" } : undefined}
            >
              <span
                className="avatar-tint flex size-12 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                style={{ ["--tint-h" as string]: c.hue }}
              >
                {initials(c.name)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[15px] font-medium">{c.name}</span>
                  <span className={c.unread ? "shrink-0 text-[11px] font-semibold text-accent" : "shrink-0 text-[11px] text-text-subtle"}>
                    {c.time}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] text-text-subtle">{c.preview}</span>
                  {c.unread > 0 && (
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-fg">
                      {c.unread}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Conversa ── */}
      <div className="flex min-h-0 flex-col">
        {/* Header */}
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4" style={{ background: "var(--wa-bar)" }}>
          <span className="avatar-tint flex size-10 items-center justify-center rounded-full text-xs font-semibold" style={{ ["--tint-h" as string]: 330 }}>
            MS
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold leading-tight">Maria Silva</div>
            <div className="truncate text-xs text-text-subtle">+55 31 98765-4321 · online</div>
          </div>
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">Em atendimento</span>
        </div>

        {/* Thread com papel de parede */}
        <div className="wa-chat-bg min-h-0 flex-1 overflow-y-auto py-3">
          <div className="sticky top-0 z-10 flex justify-center py-2">
            <span className="rounded-lg px-3 py-1 text-[11px] font-medium uppercase tracking-wide shadow-sm" style={{ background: "var(--wa-chip-bg)", color: "var(--wa-chip-fg)" }}>
              Hoje
            </span>
          </div>
          {MESSAGES.map((m, i) => {
            const prev = MESSAGES[i - 1];
            const tail = !prev || prev.direction !== m.direction;
            return <MessageBubble key={m.id} message={m} tail={tail} />;
          })}
        </div>

        {/* Composer com barra de "respondendo a" (quoted reply) */}
        <div style={{ background: "var(--wa-bar)" }}>
          <div className="mx-3 mt-2 flex items-start gap-2 rounded-t-lg border-l-[3px] px-3 py-2 text-xs" style={{ borderColor: "var(--wa-quote)", background: "var(--wa-in)" }}>
            <div className="min-w-0 flex-1">
              <div className="font-semibold" style={{ color: "var(--wa-quote)" }}>Maria Silva</div>
              <div className="truncate opacity-70">Quero sim!</div>
            </div>
            <span className="text-text-subtle">✕</span>
          </div>
          <div className="flex items-end gap-1.5 px-3 py-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center text-text-subtle">
              <Paperclip size={20} weight="regular" aria-hidden />
            </span>
            <div className="flex-1 rounded-lg px-3.5 py-2 text-sm text-text-subtle shadow-sm" style={{ background: "var(--wa-in)" }}>
              Digite uma mensagem
            </div>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg">
              <PaperPlaneTilt size={18} weight="fill" aria-hidden />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
