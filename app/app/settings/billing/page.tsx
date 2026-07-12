import { requireAuth } from "@/lib/auth/server";
import { Card } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  await requireAuth();
  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">Planos, faturas e cobrança.</p>
      </header>
      <Card className="max-w-xl p-6">
        <h2 className="text-sm font-semibold">Em breve — Fase 2</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Billing entra na Fase 2 do roadmap. Para questões de pagamento, contate{" "}
          <a className="underline" href="mailto:suporte@zapinbox.com.br">
            suporte@zapinbox.com.br
          </a>
          .
        </p>
      </Card>
    </div>
  );
}
