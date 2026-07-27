/**
 * Regras de permissão que não caem num simples "papel X pra cima".
 *
 * Decisão Darlei (26/07): o **Gerente** ganhou LGPD (ver/aprovar pedidos),
 * ligar/pausar o agente de IA, conectar/reconectar o WhatsApp e administrar a
 * equipe — **menos os admins**. Essa última parte é o ponto: se o gerente
 * pudesse criar ou promover admin, ele viraria admin sozinho em dois cliques, e
 * a distinção entre os dois papéis deixaria de existir.
 *
 * Continuam exclusivos de admin: configurações do tenant, opções dos campos,
 * tokens de API, criar/editar/arquivar agente de IA, chaves e orçamento de IA e
 * a anonimização direta de contato (`/api/v1/lgpd/anonymize`, irreversível e
 * fora do fluxo de pedido).
 */
import { ROLE_RANK, type Role } from "./types";

/** Quem entra na tela de Equipe e mexe em membros: gerente pra cima. */
export function canManageTeam(role: Role | undefined): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK.manager;
}

/**
 * Pode CONCEDER este nível? Gerente distribui até gerente; admin, qualquer um.
 */
export function canAssignRole(actorRole: Role, roleToAssign: Role): boolean {
  if (actorRole === "admin") return true;
  if (actorRole === "manager") return roleToAssign !== "admin";
  return false;
}

/**
 * Pode mexer NESTE membro (mudar nível, revogar, definir WhatsApp de avisos)?
 * Gerente não toca em admin.
 */
export function canManageMember(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === "admin") return true;
  if (actorRole === "manager") return targetRole !== "admin";
  return false;
}
