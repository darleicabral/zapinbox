/**
 * CPF: normalização, hash de busca e criptografia at-rest.
 *
 * `cpf_hash` = sha256(hex) dos 11 dígitos — permite busca exata e dedup sem
 * expor o número. `cpf_encrypted` (bytea) guarda o CPF cifrado.
 *
 * 🐛 04/08/2026 — POR QUE ISTO MUDOU DE LUGAR. A cifragem era uma RPC do banco
 * (`encrypt_cpf`) que **nunca foi criada** (está como "deferred" no EPIC-05
 * desde abril). O código dizia tolerar a ausência, mas não tolerava: gravava
 * `cpf_hash` sem `cpf_encrypted` e o CHECK `contacts_cpf_consistency` derrubava
 * o INSERT inteiro. Sintoma na tela: "Erro interno" ao cadastrar contato **com
 * CPF** — o Darlei achou que era por causa do telefone internacional, e era o
 * campo CPF.
 *
 * Agora a cifragem é aqui, com AES-256-GCM e a chave `CPF_ENCRYPTION_KEY` que
 * **já existia na Vercel** (validada em lib/env.ts e nunca usada). Nenhuma
 * função nova no banco, nenhuma chave nova para administrar. Não havia CPF
 * gravado em contato nenhum (conferido: 0 linhas com cpf_hash), então não há
 * formato legado a manter.
 *
 * Formato do bytea: `iv(12) || tag(16) || ciphertext`, entregue ao Postgres na
 * notação hexadecimal `\x…` (é assim que o PostgREST aceita e devolve bytea).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const IV_BYTES = 12; // padrão do GCM
const TAG_BYTES = 16;

export function normalizeCpf(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** sha256 hex do CPF normalizado, p/ busca exata via `cpf_hash`. */
export function hashCpf(raw: string): string {
  return createHash("sha256").update(normalizeCpf(raw)).digest("hex");
}

/**
 * Chave de 32 bytes a partir do env (base64 de 32 bytes = 44 chars). Devolve
 * null quando ausente/curta — quem chama DEVE tratar, nunca gravar hash sem
 * cifra (ver o CHECK citado acima).
 */
function cpfKey(): Buffer | null {
  const raw = (process.env.CPF_ENCRYPTION_KEY ?? "").trim();
  if (!raw) return null;
  const buf = Buffer.from(raw, "base64");
  return buf.length === 32 ? buf : null;
}

export function isCpfEncryptionAvailable(): boolean {
  return cpfKey() !== null;
}

/** CPF em claro → literal bytea (`\x…`) pronto pro insert. Null se sem chave. */
export function encryptCpf(plaintext: string): string | null {
  const key = cpfKey();
  if (!key) return null;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(normalizeCpf(plaintext), "utf8"), cipher.final()]);
  return `\\x${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("hex")}`;
}

/**
 * bytea (`\x…`, como o PostgREST devolve) → CPF em claro. Null quando falta
 * chave, o dado está truncado ou a autenticação do GCM falha (chave trocada).
 */
export function decryptCpf(stored: string | null | undefined): string | null {
  const key = cpfKey();
  if (!key || !stored) return null;
  const hex = stored.startsWith("\\x") ? stored.slice(2) : stored;
  const buf = Buffer.from(hex, "hex");
  if (buf.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, IV_BYTES));
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const out = Buffer.concat([
      decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
    return out.toString("utf8");
  } catch {
    return null; // tag inválida = chave diferente da que cifrou
  }
}
