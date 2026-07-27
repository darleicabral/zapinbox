"use client";
/**
 * Importar contatos de um arquivo CSV.
 *
 * O parsing é local (lib/contacts/csv.ts) para o usuário CONFERIR antes de
 * gravar: quantas linhas, o que casou com cada coluna, quem ficou sem telefone.
 * Só depois manda pro servidor, em lotes (hooks/contacts/useImportContacts).
 */
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Warning, UploadSimple, CheckCircle } from "@/lib/ui/icons";
import { useImportContacts, type ImportSummary } from "@/hooks/contacts/useImportContacts";
import {
  dedupeRows,
  parseContactsCsv,
  type ParsedContactsFile,
  type ParsedContactRow,
} from "@/lib/contacts/csv";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Opções cadastradas de Empreendimento — usadas para normalizar o que vem no arquivo. */
  empreendimentos?: string[];
}

const FIELD_LABEL: Record<string, string> = {
  name: "Nome",
  phone: "Telefone",
  email: "E-mail",
  empreendimento: "Empreendimento",
};

/** Excel pt-BR salva CSV em Windows-1252; UTF-8 vira "�" nos acentos. */
async function readFileText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buf);
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("windows-1252").decode(buf);
  } catch {
    return utf8;
  }
}

export function ImportContactsDialog({ open, onOpenChange, empreendimentos = [] }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedContactsFile | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const { run, isPending, progress } = useImportContacts();

  const prepared = useMemo(() => {
    if (!parsed) return null;
    const usable = parsed.rows.filter((r) => !r.skipped);
    const { unique, duplicates } = dedupeRows(usable);
    return {
      unique,
      duplicates,
      skipped: parsed.rows.length - usable.length,
      semTelefone: unique.filter((r) => !r.phone).length,
    };
  }, [parsed]);

  function reset() {
    setFileName(null);
    setParsed(null);
    setSummary(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function onPick(file: File | undefined) {
    if (!file) return;
    setSummary(null);
    try {
      const text = await readFileText(file);
      const result = parseContactsCsv(text, { empreendimentos });
      if (result.rows.length === 0) {
        toast.error("Não encontrei linhas de dados nesse arquivo.");
        return;
      }
      if (!Object.values(result.mapping).some((f) => f === "name" || f === "phone")) {
        toast.error("Nenhuma coluna de nome ou telefone reconhecida no cabeçalho.");
      }
      setFileName(file.name);
      setParsed(result);
    } catch {
      toast.error("Não consegui ler o arquivo.");
    }
  }

  async function onImport() {
    if (!prepared || prepared.unique.length === 0) return;
    const result = await run(prepared.unique);
    if (!result) return;
    setSummary(result);
    toast.success(
      `${result.created} contato(s) criado(s) · ${result.updated} atualizado(s) · ${result.unchanged} sem mudança.`,
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Importar contatos</DialogTitle>
          <DialogDescription>
            Arquivo CSV (planilha salva como &quot;CSV&quot;). Reconheço as colunas Nome/Cliente,
            Telefone/Celular, E-mail e Empreendimento — o resto é ignorado.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <div className="flex items-center gap-3">
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="hidden"
              onChange={(e) => void onPick(e.target.files?.[0])}
            />
            <Button
              variant="outline"
              onClick={() => inputRef.current?.click()}
              disabled={isPending}
            >
              <UploadSimple size={16} weight="bold" aria-hidden />
              <span>{fileName ? "Trocar arquivo" : "Escolher arquivo"}</span>
            </Button>
            {fileName && <span className="truncate text-sm text-muted-foreground">{fileName}</span>}
          </div>

          {parsed && prepared && !summary && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Linhas no arquivo" value={parsed.rows.length} />
                <Stat label="Vão ser importadas" value={prepared.unique.length} />
                <Stat label="Repetidas (ignoradas)" value={prepared.duplicates} />
                <Stat label="Sem telefone" value={prepared.semTelefone} />
              </div>

              <div className="rounded-lg border border-border bg-surface-muted p-3 text-xs">
                <p className="mb-1 font-medium">Colunas reconhecidas</p>
                <ul className="space-y-0.5 text-muted-foreground">
                  {Object.entries(parsed.mapping).map(([header, field]) => (
                    <li key={header}>
                      <span className="font-medium text-foreground">{header}</span> →{" "}
                      {FIELD_LABEL[field] ?? field}
                    </li>
                  ))}
                </ul>
                {parsed.ignored.length > 0 && (
                  <p className="mt-2 text-muted-foreground">
                    Ignoradas: {parsed.ignored.join(", ")}
                  </p>
                )}
              </div>

              {prepared.semTelefone > 0 && (
                <p className="flex items-start gap-1.5 text-xs text-warning-fg">
                  <Warning size={14} weight="fill" className="mt-0.5 shrink-0" aria-hidden />
                  {prepared.semTelefone} contato(s) sem telefone válido. Eles entram na lista, mas o
                  botão de WhatsApp fica desabilitado até você preencher o número.
                </p>
              )}

              <PreviewTable rows={prepared.unique.slice(0, 5)} />
            </>
          )}

          {summary && (
            <div className="border-success/40 space-y-2 rounded-lg border bg-success-bg p-3 text-sm">
              <p className="flex items-center gap-1.5 font-medium text-success-fg">
                <CheckCircle size={16} weight="fill" aria-hidden />
                Importação concluída
              </p>
              <ul className="text-muted-foreground">
                <li>{summary.created} criado(s)</li>
                <li>{summary.updated} atualizado(s) (completei o que estava vazio)</li>
                <li>{summary.unchanged} já estavam iguais</li>
              </ul>
              {summary.errors.length > 0 && (
                <div className="text-xs text-error-fg">
                  <p className="font-medium">{summary.errors.length} erro(s):</p>
                  <ul>
                    {summary.errors.slice(0, 5).map((e, i) => (
                      <li key={i}>
                        {e.line ? `linha ${e.line}: ` : ""}
                        {e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            {summary ? "Fechar" : "Cancelar"}
          </Button>
          {!summary && (
            <Button
              onClick={onImport}
              disabled={isPending || !prepared || prepared.unique.length === 0}
            >
              {isPending
                ? `Importando ${progress.done}/${progress.total}…`
                : `Importar ${prepared?.unique.length ?? 0} contato(s)`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface-muted p-2.5">
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

function PreviewTable({ rows }: { rows: ParsedContactRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead className="bg-surface-muted text-left text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 font-medium">Nome</th>
            <th className="px-2 py-1.5 font-medium">Telefone</th>
            <th className="px-2 py-1.5 font-medium">E-mail</th>
            <th className="px-2 py-1.5 font-medium">Empreendimento</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.line} className="border-t border-border">
              <td className="px-2 py-1.5">{r.name ?? "—"}</td>
              <td className="px-2 py-1.5">{r.phone ?? "—"}</td>
              <td className="px-2 py-1.5">{r.email ?? "—"}</td>
              <td className="px-2 py-1.5">{r.empreendimento ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
