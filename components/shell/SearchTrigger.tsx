"use client";
import { useHotkeys } from "react-hotkeys-hook";
import { MagnifyingGlass } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";

export function SearchTrigger() {
  useHotkeys("mod+k", () => {
    // Placeholder; cmd-k palette comes in EPIC-03 / EPIC-12
    // eslint-disable-next-line no-console
    console.info("[search] Cmd+K trigger — UI not yet implemented");
  }, { preventDefault: true });

  return (
    <Button variant="outline" size="sm" className="gap-2 text-muted-foreground">
      <MagnifyingGlass size={14} aria-hidden />
      <span className="hidden md:inline">Buscar...</span>
      <kbd className="ml-2 hidden md:inline rounded border bg-muted px-1.5 py-0.5 text-[10px]">⌘K</kbd>
    </Button>
  );
}
