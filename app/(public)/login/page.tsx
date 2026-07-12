import { LoginForm } from "@/components/auth/LoginForm";
import { Logo } from "@/components/brand/Logo";

export const metadata = { title: "Entrar" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Logo />
        <h1 className="text-2xl font-semibold tracking-tight">Entrar</h1>
      </div>
      <LoginForm next={next} />
    </div>
  );
}
