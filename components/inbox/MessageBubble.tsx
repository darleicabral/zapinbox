"use client";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  Check,
  Checks,
  ImageIcon,
  MusicNote,
  FileText,
  Robot,
  WarningOctagon,
} from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Message } from "@/lib/types/messaging";
import { CitationButton } from "@/components/ai/CitationButton";
import { extractCitations, isAiGeneratedMessage } from "@/lib/ai/citations/types";

/** Referência da mensagem citada (quoted reply), guardada em metadata.quoted. */
interface QuotedRef {
  author: string;
  text: string;
  from_me?: boolean;
}

interface Props {
  message: Message;
  debugCitations?: boolean;
  /** Rabinho: só no 1º balão de um grupo do mesmo remetente (igual WhatsApp). */
  tail?: boolean;
}

const MEDIA_LABEL: Record<string, { Icon: typeof ImageIcon; label: string }> = {
  image: { Icon: ImageIcon, label: "Imagem" },
  audio: { Icon: MusicNote, label: "Áudio" },
  video: { Icon: ImageIcon, label: "Vídeo" },
  document: { Icon: FileText, label: "Documento" },
  sticker: { Icon: ImageIcon, label: "Figurinha" },
};

/**
 * Mídia da mensagem.
 *
 * RECEBIDA: o arquivo vive no WAHA e a rota /api/v1/messages/[id]/media faz a
 * ponte (a chave de API não pode ir pro browser). ENVIADA: não guardamos cópia
 * — mostra o nome do arquivo, que é o que dá pra prometer.
 */
function MediaContent({ message }: { message: Message }) {
  const mime = message.media_mime ?? "";
  const filename =
    typeof message.metadata?.filename === "string" ? message.metadata.filename : null;
  const entry = MEDIA_LABEL[message.type] ?? MEDIA_LABEL.document!;
  const Icon = entry.Icon;

  if (!message.media_url) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <Icon size={13} weight="duotone" aria-hidden />
        <span className="truncate">{filename ?? entry.label}</span>
      </span>
    );
  }

  const src = `/api/v1/messages/${message.id}/media`;

  if (mime.startsWith("image/") || message.type === "image" || message.type === "sticker") {
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={filename ?? "Imagem recebida"}
          loading="lazy"
          className="max-h-72 w-auto max-w-full rounded-lg"
        />
      </a>
    );
  }

  if (mime.startsWith("audio/") || message.type === "audio") {
    return <audio controls preload="none" src={src} className="w-56 max-w-full" />;
  }

  if (mime.startsWith("video/") || message.type === "video") {
    return (
      <video controls preload="metadata" src={src} className="max-h-72 max-w-full rounded-lg" />
    );
  }

  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-xs underline underline-offset-2"
    >
      <Icon size={13} weight="duotone" aria-hidden />
      <span className="truncate">{filename ?? entry.label}</span>
    </a>
  );
}

function AckIndicator({ status }: { status: string }) {
  if (status === "read") {
    return <Checks size={15} weight="bold" style={{ color: "var(--wa-tick)" }} aria-label="Lida" />;
  }
  if (status === "delivered") {
    return (
      <Checks size={15} weight="bold" style={{ color: "var(--wa-meta)" }} aria-label="Entregue" />
    );
  }
  if (status === "sent") {
    return <Check size={15} weight="bold" style={{ color: "var(--wa-meta)" }} aria-label="Enviada" />;
  }
  return null;
}

/** Cartão da mensagem citada, dentro do balão (barra colorida + autor + trecho). */
function QuotedCard({ quoted }: { quoted: QuotedRef }) {
  return (
    <div
      className="mb-1 flex flex-col gap-0.5 overflow-hidden rounded border-l-[3px] px-2 py-1 text-xs"
      style={{ borderColor: "var(--wa-quote)", background: "rgba(0,0,0,0.045)" }}
    >
      <span className="font-semibold" style={{ color: "var(--wa-quote)" }}>
        {quoted.from_me ? "Você" : quoted.author}
      </span>
      <span className="line-clamp-2 opacity-70">{quoted.text}</span>
    </div>
  );
}

export function MessageBubble({ message, debugCitations, tail = true }: Props) {
  const isOutbound = message.direction === "outbound";
  const time = format(new Date(message.sent_at), "HH:mm", { locale: ptBR });
  const isFailed = message.status === "failed";
  const aiGenerated = isAiGeneratedMessage(message.metadata);
  const citations = extractCitations(message.metadata);
  const showCitationButton = isOutbound && aiGenerated && (debugCitations ?? false);
  const senderLabel = isOutbound && message.sent_via === "ai" ? "IA" : null;
  const rawQuoted = message.metadata?.quoted;
  const quoted =
    rawQuoted && typeof rawQuoted === "object" ? (rawQuoted as QuotedRef) : null;

  return (
    <div
      className={cn(
        "flex w-full px-4",
        isOutbound ? "justify-end" : "justify-start",
        tail ? "mt-2" : "mt-0.5",
      )}
    >
      <div
        className={cn(
          // Balão WhatsApp: verde do WhatsApp no enviado, branco no recebido,
          // sombra rasa e rabinho no 1º do grupo.
          "relative max-w-[65%] rounded-lg px-2 py-1.5 text-sm shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]",
          isOutbound
            ? cn("bg-[var(--wa-out)] text-[var(--wa-out-fg)]", tail && "wa-tail-out rounded-tr-none")
            : cn("bg-[var(--wa-in)] text-[var(--wa-in-fg)]", tail && "wa-tail-in rounded-tl-none"),
          isFailed && "ring-1 ring-error",
        )}
      >
        {senderLabel && (
          <div
            className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide"
            style={{ color: "var(--wa-quote)" }}
          >
            <Robot size={10} weight="duotone" aria-hidden />
            {senderLabel}
          </div>
        )}

        {quoted && <QuotedCard quoted={quoted} />}

        {/* Mídia primeiro, texto embaixo como legenda — igual ao WhatsApp. */}
        {message.type !== "text" && (
          <div className={cn(message.body && "mb-1")}>
            <MediaContent message={message} />
          </div>
        )}

        {message.body && (
          <p className="whitespace-pre-wrap break-words leading-[1.35]">{message.body}</p>
        )}

        <div
          className="mt-0.5 flex items-center justify-end gap-1 text-[11px] leading-none"
          style={{ color: "var(--wa-meta)" }}
        >
          <span>{time}</span>
          {showCitationButton && <CitationButton citations={citations} messageId={message.id} />}
          {isOutbound && !isFailed && <AckIndicator status={message.status} />}
          {isFailed && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-0.5 font-semibold text-destructive">
                  <WarningOctagon size={11} weight="fill" aria-hidden /> Falhou
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {message.error_message ?? message.error_code ?? "Erro desconhecido"}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}
