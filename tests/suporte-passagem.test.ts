import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { json, uid } from "../src/types";
import { api, bearer, claim, configure } from "./service-center-fixture";
import { useMercadoPago } from "./mensalidade-mp";
import {
  lastText,
  payerEmDia,
  releases,
  setupSuporte,
  talk,
  turnModule,
} from "./suporte-fixture";

useMercadoPago();

const menus = [
  { id: "humano", label: "Falar com atendente", type: "human" },
  { id: "pago", label: "Atendimento humano (pago)", type: "suporte_humano" },
];

describe("suporte: toda passagem automática para humano passa pela regra", () => {
  it("item 'humano' do menu: sem pagamento o Suporte segura e conduz; em dia passa", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, { menus });
    // Sem cadastro: segura, não muda a conversa e pede o CPF/CNPJ.
    const phone = "5511972000001";
    await talk(f, "oi", phone);
    let c = await talk(f, "1", phone);
    expect(c.state).not.toBe("waiting");
    expect(await lastText(c.id)).toContain(
      "digite o CPF ou o CNPJ de quem paga",
    );
    const held = (
      await all(
        env,
        "SELECT payload FROM events WHERE profile_id=? AND kind='conversation.updated' AND resource_id=?",
        f.profile,
        c.id,
      )
    ).map((r) => json(r.payload));
    expect(held.some((p) => p.handoff_held?.module === "suporte")).toBe(true);
    expect(await releases(c.id)).toHaveLength(0);

    // Pagador em dia: o núcleo passa direto, sem liberação do Suporte.
    const paid = "5511972000002";
    await payerEmDia(s, paid);
    await talk(f, "oi", paid);
    c = await talk(f, "1", paid);
    expect(c.state).toBe("waiting");
  });

  it("depois da liberação (cortesia) o pedido de humano segue", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, { menus });
    const phone = "5511972000003";
    let c = await talk(f, "oi", phone);
    await claim(f, f.member, c.id);
    const token = await bearer(f.member);
    await api(
      token,
      `/profiles/${f.profile}/suporte/conversations/${c.id}/courtesy`,
      "POST",
      {
        reason: "Cliente antigo",
        hours: 4,
      },
    );
    // A conversa volta ao bot (cortesia de 4 h ainda vale); o cliente pede
    // humano de novo.
    await exec(
      env,
      "UPDATE conversations SET state='ai',owner=NULL WHERE id=?",
      c.id,
    );
    await talk(f, "menu", phone);
    c = await talk(f, "1", phone);
    expect(c.state).toBe("waiting");
    expect(
      await one(
        env,
        "SELECT count(*) AS n FROM suporte_sessions WHERE conversation_id=?",
        c.id,
      ),
    ).toEqual({ n: 0 });
  });

  it("Suporte desligado (efetivo): o núcleo passa sem consultar", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, { menus: [menus[0]] });
    await turnModule(f, "suporte", false);
    const phone = "5511972000004";
    await talk(f, "oi", phone);
    const c = await talk(f, "1", phone);
    expect(c.state).toBe("waiting");
    expect(uid()).toBeTruthy();
  });
});
