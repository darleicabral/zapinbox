/**
 * Testes da criptografia de CPF (lib/contacts/cpf.ts).
 *
 * O que importa garantir: ida e volta com a mesma chave, formato de bytea que o
 * Postgres aceita (`\x…`), cifras diferentes para o mesmo CPF (IV aleatório — se
 * fossem iguais, daria para descobrir CPF repetido comparando o campo cifrado) e
 * recusa silenciosa quando a chave muda ou o dado é adulterado.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { decryptCpf, encryptCpf, hashCpf, isCpfEncryptionAvailable, normalizeCpf } from "@/lib/contacts/cpf";

const CHAVE_A = Buffer.alloc(32, 7).toString("base64");
const CHAVE_B = Buffer.alloc(32, 9).toString("base64");
const CPF = "111.572.226-33";
const original = process.env.CPF_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.CPF_ENCRYPTION_KEY = CHAVE_A;
});
afterEach(() => {
  if (original === undefined) delete process.env.CPF_ENCRYPTION_KEY;
  else process.env.CPF_ENCRYPTION_KEY = original;
});

describe("CPF at-rest", () => {
  it("cifra e decifra, guardando só os dígitos", () => {
    const guardado = encryptCpf(CPF);
    expect(guardado).toBeTruthy();
    expect(decryptCpf(guardado)).toBe("11157222633");
  });

  it("gera literal bytea hexadecimal que o Postgres aceita", () => {
    const guardado = encryptCpf(CPF)!;
    expect(guardado.startsWith("\\x")).toBe(true);
    expect(guardado.slice(2)).toMatch(/^[0-9a-f]+$/);
    // iv(12) + tag(16) + 11 dígitos = 39 bytes = 78 hex
    expect(guardado.slice(2).length).toBe(78);
  });

  it("nunca repete a cifra do mesmo CPF (IV aleatório)", () => {
    expect(encryptCpf(CPF)).not.toBe(encryptCpf(CPF));
    // mas o hash de busca é estável, senão a deduplicação não acha
    expect(hashCpf(CPF)).toBe(hashCpf("11157222633"));
  });

  it("devolve null com chave trocada, em vez de lixo", () => {
    const guardado = encryptCpf(CPF);
    process.env.CPF_ENCRYPTION_KEY = CHAVE_B;
    expect(decryptCpf(guardado)).toBeNull();
  });

  it("devolve null para dado adulterado ou curto", () => {
    const guardado = encryptCpf(CPF)!;
    const mexido = guardado.slice(0, -2) + (guardado.endsWith("00") ? "11" : "00");
    expect(decryptCpf(mexido)).toBeNull();
    expect(decryptCpf("\\xdeadbeef")).toBeNull();
    expect(decryptCpf(null)).toBeNull();
  });

  it("sem chave, avisa em vez de cifrar", () => {
    delete process.env.CPF_ENCRYPTION_KEY;
    expect(isCpfEncryptionAvailable()).toBe(false);
    expect(encryptCpf(CPF)).toBeNull();
  });

  it("recusa chave de tamanho errado", () => {
    process.env.CPF_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(isCpfEncryptionAvailable()).toBe(false);
    expect(encryptCpf(CPF)).toBeNull();
  });

  it("normaliza qualquer pontuação", () => {
    expect(normalizeCpf(" 111.572.226-33 ")).toBe("11157222633");
  });
});
