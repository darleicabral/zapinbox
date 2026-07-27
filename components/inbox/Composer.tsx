"use client";
import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { PaperPlaneTilt, Paperclip, X, FileText, CircleNotch } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import {
  messageTypeForMime,
  prepareAttachment,
  type PreparedAttachment,
} from "@/lib/inbox/attachment";
import { cn } from "@/lib/utils";

export interface ComposerHandle {
  focus: () => void;
}

interface Props {
  conversationId: string;
  disabled?: boolean;
  /** Set true when contact is blocked / anonymized — explanation shown. */
  blockedReason?: string | null;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { conversationId, disabled, blockedReason },
  ref,
) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [attachment, setAttachment] = useState<PreparedAttachment | null>(null);
  const [preparing, setPreparing] = useState(false);
  const send = useSendMessage();

  function clearAttachment() {
    setAttachment((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    setPreparing(true);
    try {
      const result = await prepareAttachment(file);
      if (!result.ok) {
        toast.error(result.error);
        if (fileRef.current) fileRef.current.value = "";
        return;
      }
      clearAttachment();
      setAttachment(result.attachment);
      taRef.current?.focus();
    } finally {
      setPreparing(false);
    }
  }

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
  }));

  const isDisabled = disabled || !!blockedReason || send.isPending;

  function autoresize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  function handleSubmit() {
    const body = text.trim();
    if (isDisabled || preparing) return;
    if (!body && !attachment) return;

    send.mutate(
      attachment
        ? {
            conversation_id: conversationId,
            // Com anexo o texto vira legenda (o WhatsApp manda os dois juntos).
            ...(body ? { body } : {}),
            type: messageTypeForMime(attachment.mime),
            media_mime: attachment.mime,
            media_filename: attachment.filename,
            media_base64: attachment.base64,
            metadata: { filename: attachment.filename, bytes: attachment.bytes },
          }
        : { conversation_id: conversationId, body, type: "text" },
      {
        onSuccess: () => {
          setText("");
          clearAttachment();
          requestAnimationFrame(() => autoresize());
        },
      },
    );
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  if (blockedReason) {
    return (
      <div className="bg-muted/40 border-t border-border px-4 py-3 text-center text-xs text-muted-foreground">
        {blockedReason}
      </div>
    );
  }

  return (
    <div className="border-t border-border bg-surface px-3 py-2.5">
      {attachment && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-border bg-field p-2">
          {attachment.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={attachment.previewUrl} alt="" className="size-10 rounded-md object-cover" />
          ) : (
            <span className="flex size-10 items-center justify-center rounded-md bg-surface-muted text-text-subtle">
              <FileText size={18} weight="duotone" aria-hidden />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-text">{attachment.filename}</p>
            <p className="text-[11px] text-text-subtle">
              {(attachment.bytes / 1000).toFixed(0)} KB · vai junto com o texto
            </p>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            onClick={clearAttachment}
            aria-label="Remover anexo"
            disabled={send.isPending}
          >
            <X size={14} weight="bold" aria-hidden />
          </Button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept="image/*,application/pdf,audio/*,video/*,.doc,.docx,.xls,.xlsx"
          onChange={(e) => void onPickFile(e.target.files?.[0])}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9 shrink-0"
          aria-label="Anexar arquivo"
          title="Anexar imagem, PDF ou documento (até 2,8 MB)"
          onClick={() => fileRef.current?.click()}
          disabled={isDisabled || preparing}
        >
          {preparing ? (
            <CircleNotch size={16} weight="bold" className="animate-spin" aria-hidden />
          ) : (
            <Paperclip size={16} weight="regular" aria-hidden />
          )}
        </Button>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autoresize();
          }}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Escreva uma mensagem… (Enter envia, Shift+Enter quebra linha)"
          className={cn(
            "max-h-40 min-h-9 flex-1 resize-none rounded-lg border border-border bg-field px-3 py-2 text-sm text-text",
            "transition-colors duration-fast ease-out placeholder:text-text-subtle hover:border-border-strong",
            "focus:ring-accent/20 focus:border-accent focus:bg-surface focus:outline-none focus:ring-2",
          )}
          disabled={isDisabled}
          aria-label="Mensagem"
        />
        <Button
          type="button"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={handleSubmit}
          disabled={isDisabled || preparing || (!text.trim() && !attachment)}
          aria-label="Enviar"
        >
          <PaperPlaneTilt size={16} weight="fill" aria-hidden />
        </Button>
      </div>
    </div>
  );
});
