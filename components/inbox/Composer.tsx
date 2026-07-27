"use client";
import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { PaperPlaneTilt, Paperclip } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
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
  const send = useSendMessage();

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
    if (!body || isDisabled) return;
    send.mutate(
      { conversation_id: conversationId, body, type: "text" },
      {
        onSuccess: () => {
          setText("");
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
      <div className="flex items-end gap-2">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9 shrink-0"
          aria-label="Anexar"
          disabled
          title="Em breve"
        >
          <Paperclip size={16} weight="regular" aria-hidden />
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
          disabled={isDisabled || !text.trim()}
          aria-label="Enviar"
        >
          <PaperPlaneTilt size={16} weight="fill" aria-hidden />
        </Button>
      </div>
    </div>
  );
});
