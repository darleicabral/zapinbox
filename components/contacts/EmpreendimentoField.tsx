"use client";
/**
 * Campo "Empreendimento" do contato (contacts.custom_fields.empreendimento).
 *
 * As opções vêm do MESMO campo do pipeline (Configurações → Opções dos campos),
 * carregadas no servidor. Sem opções cadastradas o campo nem aparece — org que
 * não trabalha por empreendimento não ganha campo vazio no formulário.
 */
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NONE = "__none__";

interface Props {
  id: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}

export function EmpreendimentoField({ id, options, value, onChange }: Props) {
  if (options.length === 0) return null;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Empreendimento</Label>
      <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Selecione…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>—</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
