// Revisão de segurança A1: argumento de ferramenta MCP não muda a rota.
// Antes, `order_id = "../mensalidade/payers?limit=200"` virava a listagem de
// pagadores com documento, e `conversation_id = "../mensalidade/installments/
// <id>/pay?"` dava baixa manual na parcela, com uma chave só de conversas.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { one } from "../src/db";
import { perform } from "../src/service";
import { uid } from "../src/types";
import { checkedCall } from "../src/mcp";
import { fixture } from "./service-center-fixture";
import { useMercadoPago } from "./mensalidade-mp";
import { payerEmAtraso, setupSuporte } from "./suporte-fixture";
import { botKey, mcp, tool } from "./mcp-fixture";

useMercadoPago();

async function scenario() {
  const s = await setupSuporte();
  const { f } = s;
  for (const id of ["agenda", "os", "pedido", "reserva"])
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id, enabled: true },
      uid(),
    );
  await payerEmAtraso(s, "5511978000001");
  const inst = await one(
    env,
    "SELECT id FROM mensalidade_installments WHERE profile_id=? AND status IN ('open','overdue') LIMIT 1",
    f.profile,
  );
  return { s, f, inst, key: await botKey(f) };
}

const DOCUMENT = "11222333000181";

describe("ferramentas MCP: argumento não muda a rota (revisão A1)", () => {
  it("'../' em conversation_id não lê pagadores nem dá baixa em parcela", async () => {
    const { f, inst, key } = await scenario();
    const attacks: [string, any][] = [
      [
        "pedido_enviar_carrinho",
        { conversation_id: `../mensalidade/installments/${inst.id}/pay?` },
      ],
      [
        "pedido_enviar_carrinho",
        {
          conversation_id: `..%2Fmensalidade%2Finstallments%2F${inst.id}%2Fpay`,
        },
      ],
      ["os_situacao", { conversation_id: "../mensalidade/payers?limit=200" }],
      [
        "agenda_meus_agendamentos",
        { conversation_id: "../../mensalidade/payers?limit=200" },
      ],
      [
        "agenda_remarcar",
        {
          conversation_id: `../mensalidade/installments/${inst.id}/pay#`,
          appointment_id: "x",
          starts: Date.now(),
        },
      ],
      ["reserva_minhas", { conversation_id: "../mensalidade/payers" }],
      ["mensalidade_situacao", { conversation_id: "../mensalidade/payers" }],
      ["mensalidade_segunda_via", { conversation_id: ".." }],
      ["get_conversation", { conversation_id: "../mensalidade/payers" }],
      ["list_web_steps", { conversation_id: "../mensalidade/payers?" }],
    ];
    for (const [name, args] of attacks) {
      const result = await tool(key, name, {
        profile: f.profile,
        idempotency_key: uid(),
        ...args,
      });
      expect(result.ok, `${name} ${JSON.stringify(args)}`).toBe(false);
      expect(String(result.error)).not.toContain(DOCUMENT);
      expect(String(result.error)).toMatch(/inválid/);
    }
    expect(
      await one(
        env,
        "SELECT status,paid_via FROM mensalidade_installments WHERE id=?",
        inst.id,
      ),
    ).toMatchObject({ paid_via: null });
    expect(
      (
        await one(
          env,
          "SELECT status FROM mensalidade_installments WHERE id=?",
          inst.id,
        )
      ).status,
    ).not.toBe("paid");
  });

  it("profile com caminho ou de outra área é recusado", async () => {
    const { f, key } = await scenario();
    const other = await fixture();
    for (const profile of [
      `${f.profile}/mensalidade/payers?x=`,
      `${f.profile}/../${other.profile}`,
      other.profile,
      "..",
    ]) {
      const result = await tool(key, "agenda_servicos", { profile });
      expect(result.ok, profile).toBe(false);
      expect(String(result.error)).toMatch(/profile inválido/);
    }
    // A mesma ferramenta com a área da chave continua funcionando.
    expect(
      (await tool(key, "agenda_servicos", { profile: f.profile })).ok,
    ).toBe(true);
  });

  it("caminho só sai do modelo da ferramenta, com os segmentos codificados", () => {
    const t = (path: (a: any, p: string) => string) => ({
      name: "t",
      description: "",
      input: { profile: {}, id: { type: "string" } },
      call: (a: any, p: string) => ({ path: path(a, p), body: { id: a.id } }),
    });
    const ok = checkedCall(
      t((a, p) => `/profiles/${p}/things/${a.id}`),
      { id: "abc:1" },
      "area-1",
    );
    // Corpo com o valor original; caminho com o segmento codificado.
    expect(ok).toEqual({
      path: "/profiles/area-1/things/abc%3A1",
      body: { id: "abc:1" },
    });
    for (const id of ["..", ".", "a/b", "a?b", "a#b", "a%2Fb", "a b", ""])
      if (id)
        expect(
          () =>
            checkedCall(
              t((a, p) => `/profiles/${p}/things/${a.id}`),
              { id },
              "area-1",
            ),
          id,
        ).toThrow(/inválido/);
    // Ferramenta que monta consulta no caminho a partir do argumento: recusada.
    expect(() =>
      checkedCall(
        t((a, p) => `/profiles/${p}/things?id=${a.id}`),
        { id: "abc" },
        "area-1",
      ),
    ).toThrow(/Modelo de caminho inválido/);
    // Ferramenta cujo caminho depende do valor (não é só interpolação).
    expect(() =>
      checkedCall(
        t((a, p) =>
          a.id.startsWith("~~")
            ? `/profiles/${p}/things/${a.id}`
            : `/profiles/${p}/other/${a.id}`,
        ),
        { id: "abc" },
        "area-1",
      ),
    ).toThrow(/não confere com o modelo/);
  });

  it("chamadas legítimas continuam passando pelo MCP", async () => {
    const { f, key } = await scenario();
    const list = await mcp(key, "tools/call", {
      name: "list_conversations",
      arguments: { profile: f.profile },
    });
    expect(list.error).toBeUndefined();
    expect(list.result.isError ?? false).toBe(false);
  });
});
