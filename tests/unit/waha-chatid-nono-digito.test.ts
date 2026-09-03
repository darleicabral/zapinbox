/**
 * @vitest-environment node
 *
 * 03/09/2026 — os corretores da Avant não recebiam NENHUMA notificação, e a
 * tela do CRM mostrava tudo como enviado. Causa: nono dígito.
 *
 * Conta brasileira registrada antes de 2012 tem JID sem o 9. O telefone de
 * aviso é digitado à mão no formato novo (+5531992953088), o código montava
 * `5531992953088@c.us`, e esse JID não existe. O WhatsApp não recusa: cria a
 * mensagem, devolve o eco pelo webhook (por isso aparecia na tela) e não
 * entrega a ninguém — as 31 notificações do dia ficaram com ack=0.
 *
 * O WAHA sabe o JID certo (`/api/contacts/check-exists`), e foi o que provou o
 * diagnóstico:
 *   5531992953088 -> 553192953088@c.us
 *   5531984407819 -> 553184407819@c.us
 */
import { describe, expect, it } from "vitest";

import { escolherChatId } from "@/lib/waha/send";

const INGENUO = "5531992953088@c.us";
const REAL = "553192953088@c.us";

describe("escolherChatId", () => {
  it("usa o JID do WhatsApp quando ele difere (o caso do nono dígito)", () => {
    expect(escolherChatId(INGENUO, { numberExists: true, chatId: REAL })).toBe(REAL);
  });

  it("número que não está no WhatsApp devolve null, pra não enviar no vazio", () => {
    expect(escolherChatId(INGENUO, { numberExists: false, chatId: null })).toBeNull();
  });

  it("WAHA fora do ar cai no ingênuo — não piora o que já existia", () => {
    expect(escolherChatId(INGENUO, null)).toBe(INGENUO);
  });

  it("resposta sem chatId cai no ingênuo", () => {
    expect(escolherChatId(INGENUO, { numberExists: true, chatId: null })).toBe(INGENUO);
    expect(escolherChatId(INGENUO, { numberExists: true, chatId: "  " })).toBe(INGENUO);
  });

  it("número já no formato antigo passa igual", () => {
    expect(escolherChatId(REAL, { numberExists: true, chatId: REAL })).toBe(REAL);
  });

  it("sem telefone não inventa destinatário", () => {
    expect(escolherChatId(null, { numberExists: true, chatId: REAL })).toBe(REAL);
    expect(escolherChatId(null, null)).toBeNull();
  });
});
