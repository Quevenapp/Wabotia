// Revisão (sessão A) do achado 2 do PLANO-BOTS (sessão H): a pessoa agindo
// pelo bot da equipe (ator com `via`) vira is_agent no envelope do ERP
// (src/modules/erp/identity.ts) e o portão do motor recusa agente com papel
// admin ou financeiro (src/erp/domains/access/rpc/security.ts, mfaInScope),
// mesmo para ler. Teste de caracterização na 0.21.0 (main 92fdfd3): prova o
// comportamento atual, não o desejado.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec } from "../src/db";
import { internalCall } from "../src/internal-api";
import { actorForUser } from "../src/security";
import type { Actor } from "../src/types";
import { erpIdentity } from "../src/modules/erp/identity";
import { fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";

const via = (run: string) => ({
  kind: "bot" as const,
  bot_id: "bot-teste",
  run_id: run,
  masked: true,
});

async function setup() {
  const f = await fixture();
  await setModule(f.profile, "erp", true, f.admin.id);
  const person = async (id: string, access?: string[]) => {
    if (access)
      await exec(
        env,
        "UPDATE users SET access=? WHERE id=?",
        JSON.stringify(access),
        id,
      );
    const actor = await actorForUser(env, id);
    expect(actor, id).toBeTruthy();
    return actor as Actor;
  };
  const me = async (actor: Actor) => {
    const response = await internalCall(env, actor, {
      method: "GET",
      path: `/profiles/${f.profile}/erp/v1/me`,
    });
    return {
      status: response.status,
      body: await response.json<any>().catch(() => null),
    };
  };
  return { f, person, me };
}

describe("pessoa agindo pelo bot no ERP (achado 2 do plano dos bots)", () => {
  it(
    "administrador: lê sozinho; pelo bot vira agente e é recusado até para ler",
    { timeout: 120_000 },
    async () => {
      const { f, person, me } = await setup();
      const admin = await person(f.admin.id);
      const alone = await me(admin);
      expect(alone.status, JSON.stringify(alone.body)).toBe(200);
      // O envelope que o núcleo monta para a pessoa pelo bot.
      const envelope = await erpIdentity(
        env,
        { ...admin, via: via("r1") },
        f.profile,
        "GET",
      );
      expect(envelope.actor).toMatchObject({
        erp_role: "admin",
        is_agent: true,
      });
      const byBot = await me({ ...admin, via: via("r1") });
      console.log("admin pelo bot:", byBot.status, JSON.stringify(byBot.body));
      expect(byBot.status).toBe(403);
    },
  );

  it(
    "financeiro também é recusado pelo bot; vendas passa pelo bot",
    { timeout: 120_000 },
    async () => {
      const { f, person, me } = await setup();
      const finance = await person(f.member.id, ["erp:financeiro"]);
      expect((await me(finance)).status).toBe(200);
      const financeByBot = await me({ ...finance, via: via("r2") });
      console.log(
        "financeiro pelo bot:",
        financeByBot.status,
        JSON.stringify(financeByBot.body),
      );
      expect(financeByBot.status).toBe(403);
      const sales = await person(f.member.id, ["erp:vendas"]);
      const salesByBot = await me({ ...sales, via: via("r3") });
      expect(salesByBot.status, JSON.stringify(salesByBot.body)).toBe(200);
      expect(JSON.stringify(salesByBot.body)).toContain("vendas");
    },
  );
});
