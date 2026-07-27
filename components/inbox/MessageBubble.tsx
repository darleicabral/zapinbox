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

interface Props {
  message: Message;
  debugCitations?: boolean;
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
    return <Checks size={12} weight="bold" className="text-blue-400" aria-label="Lida" />;
  }
  if (status === "delivered") {
    return <Checks size={12} weight="bold" className="text-current/70" aria-label="Entregue" />;
  }
  if (status === "sent") {
    return <Check size={12} weight="bold" className="text-current/70" aria-label="Enviada" />;
  }
  return null;
}

export function MessageBubble({ message, debugCitations }: Props) {
  const isOutbound = message.direction === "outbound";
  const time = format(new Date(message.sent_at), "HH:mm", { locale: ptBR });
  const isFailed = message.status === "failed";
  const aiGenerated = isAiGeneratedMessage(message.metadata);
  const citations = extractCitations(message.metadata);
  const showCitationButton = isOutbound && aiGenerated && (debugCitations ?? false);
  const senderLabel = (() => {
    if (!isOutbound) return null;
    if (message.sent_via === "ai") return "IA";
    return null;
  })();

  return (
    <div className={cn("flex w-full px-4 py-1", isOutbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          // Balão = objeto sobre o canvas: recebida em branco com fio e sombra
          // rasa, enviada no verde cheio. Cada uma se separa da outra e as duas
          // se separam do fundo rebaixado da conversa.
          "max-w-[75%] rounded-2xl border px-3.5 py-2 text-sm shadow-xs",
          isOutbound
            ? "rounded-br-md border-bubble-out-border bg-bubble-out text-bubble-out-fg"
            : "rounded-bl-md border-border bg-surface text-text",
          isFailed && "border-error",
        )}
      >
        {senderLabel && (
          <div className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide opacity-80">
            {senderLabel === "IA" ? <Robot size={10} weight="duotone" aria-hidden /> : null}
            {senderLabel}
          </div>
        )}

        {/* Mídia primeiro, texto embaixo como legenda — igual ao WhatsApp. */}
        {message.type !== "text" && (
          <div className={cn(message.body && "mb-1.5")}>
            <MediaContent message={message} />
          </div>
        )}

        {message.body && (
          <p className="whitespace-pre-wrap break-words leading-snug">{message.body}</p>
        )}

        <div
          className={cn(
            "mt-1 flex items-center justify-end gap-1 text-[10px]",
            isOutbound ? "text-bubble-out-fg opacity-70" : "text-text-subtle",
          )}
        >
          <span>{time}</span>
          {showCitationButton && <CitationButton citations={citations} messageId={message.id} />}
          {isOutbound && !isFailed && <AckIndicator status={message.status} />}
          {isFailed && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-0.5 font-semibold text-destructive">
                  <WarningOctagon size={10} weight="fill" aria-hidden /> Falhou
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
