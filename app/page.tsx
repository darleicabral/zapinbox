import { LogoMark } from "@/components/brand/Logo";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-bg p-8">
      <div className="max-w-2xl text-center">
        <div className="mb-6 flex justify-center">
          <LogoMark className="h-16 w-16" />
        </div>
        <h1 className="text-4xl font-bold tracking-tight text-text">
          Zap<span className="text-accent">Inbox</span>
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-text-muted">
          CRM de atendimento no WhatsApp com IA que qualifica e responde
          sozinha. Multi-tenant, LGPD-nativo, sob medida pra operações
          brasileiras.
        </p>
        <p className="mt-6 text-sm text-text-muted">
          MVP em desenvolvimento. Acesse o painel via{" "}
          <code className="rounded-sm bg-surface-elevated px-2 py-0.5 font-mono text-xs text-text">
            /app
          </code>{" "}
          ou{" "}
          <code className="rounded-sm bg-surface-elevated px-2 py-0.5 font-mono text-xs text-text">
            /admin
          </code>
          .
        </p>
        <p className="mt-2 text-xs text-text-subtle">
          Health check:{" "}
          <a
            className="text-accent underline decoration-1 underline-offset-4 hover:decoration-2"
            href="/api/v1/health"
          >
            /api/v1/health
          </a>
        </p>
      </div>
    </main>
  );
}
