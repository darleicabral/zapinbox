"use client";
import { useEffect, useState } from "react";
import { MagnifyingGlass } from "@/lib/ui/icons";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { hasPosvendaModule } from "@/lib/modules";
import { cn } from "@/lib/utils";

export type InboxTab = "unassigned" | "mine" | "all" | "closed" | "ai";

export interface InboxFiltersValue {
  tab: InboxTab;
  search: string;
  onlyUnread: boolean;
  channel_session_id?: string;
}

interface Props {
  value: InboxFiltersValue;
  onChange: (next: InboxFiltersValue) => void;
}

export function InboxFilters({ value, onChange }: Props) {
  const [searchInput, setSearchInput] = useState(value.search);
  const { data: channels } = useChannelSessions({ refetchInterval: 30_000 });
  // Alternador só aparece com 2+ números — com um só não há o que alternar.
  const showChannelSwitch = (channels?.length ?? 0) >= 2;

  // Tenant de atendente único (pós-venda): as abas "Não atribuídos" e "Meus" não
  // fazem sentido — tudo é do mesmo atendente. Some, e o default cai em "Todos".
  const isPosvenda = hasPosvendaModule(useActiveOrg()?.orgId);
  const TABS: Array<{ v: InboxTab; label: string }> = isPosvenda
    ? [
        { v: "all", label: "Todos" },
        { v: "closed", label: "Fechados" },
        { v: "ai", label: "IA" },
      ]
    : [
        { v: "unassigned", label: "Não atribuídos" },
        { v: "mine", label: "Meus" },
        { v: "all", label: "Todos" },
        { v: "closed", label: "Fechados" },
        { v: "ai", label: "IA" },
      ];
  useEffect(() => {
    if (isPosvenda && (value.tab === "unassigned" || value.tab === "mine")) {
      onChange({ ...value, tab: "all" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPosvenda, value.tab]);

  // Debounce search input → propagate to parent.
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== value.search) {
        onChange({ ...value, search: searchInput });
      }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  return (
    <div className="space-y-3 border-b border-border bg-background px-3 py-3">
      <div className="relative">
        <MagnifyingGlass
          size={14}
          weight="regular"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Buscar mensagens…"
          className="h-8 pl-8 text-sm"
          aria-label="Buscar conversas"
        />
      </div>

      {showChannelSwitch && (
        <Select
          value={value.channel_session_id ?? "all"}
          onValueChange={(v) =>
            onChange({ ...value, channel_session_id: v === "all" ? undefined : v })
          }
        >
          <SelectTrigger className="h-8 text-sm" aria-label="Filtrar por número de WhatsApp">
            <SelectValue placeholder="Todos os números" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os números</SelectItem>
            {channels?.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.display_name || c.phone_number || c.waha_session_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Tabs
        value={value.tab}
        onValueChange={(v) => onChange({ ...value, tab: v as InboxTab })}
      >
        <TabsList className={cn("grid h-8 w-full", isPosvenda ? "grid-cols-3" : "grid-cols-5")}>
          {TABS.map((t) => (
            <TabsTrigger key={t.v} value={t.v} className="text-[11px]">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex items-center justify-between">
        <Label htmlFor="only-unread" className="text-xs text-muted-foreground">
          Apenas não lidos
        </Label>
        <Switch
          id="only-unread"
          checked={value.onlyUnread}
          onCheckedChange={(v) => onChange({ ...value, onlyUnread: v })}
        />
      </div>
    </div>
  );
}
