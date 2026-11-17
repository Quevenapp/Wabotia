// O painel do ERP (web/erp) contra a rota real do ERP no Worker.
// 1. A lista de telas "em implantação" (web/erp/motor.ts) é a que a rota
//    responde de fato: cada tela da lista tem a primeira leitura sem motor
//    ainda (502 do RPC não portado, 404); cada tela fora dela responde 2xx.
//    Quando um domínio for portado, este teste manda tirar a tela da lista.
// 2. O controlador do painel (web/erp/app/lib/real-access.ts) entra com o
//    administrador (erp:admin) e, sem papel erp:*, fica em "aguardando
//    liberação" (403 erp_role_required).
// 3. As pessoas com papel no ERP vêm de /people (web/erp/people.ts).
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { exec } from "../src/db";
import { bearer, fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";
import { pendingInMotor, setMotorReal } from "../web/erp/motor";
import { erpPeople } from "../web/erp/people";
import { createAccessController } from "../web/erp/app/lib/real-access";

/** Tela do painel (caminho sem /app/erp) → primeira leitura que ela faz. */
const SCREENS: [string, string][] = [
  ["/acesso", "/v1/inicio"],
  ["/painel-produtos-empresa", "/v1/estoque/painel/estoque"],
  ["/vendedores-empresa", "/v1/cadastros/vendedores"],
  ["/funcionarios-empresa", "/v1/cadastros/funcionarios"],
  ["/formas-pagamento-empresa", "/v1/cadastros/formas-pagamento"],
  [
    "/cadastros-reais?cadastro=products",
    "/v1/cadastros/products?page=1&size=100",
  ],
  [
    "/cadastros-reais?cadastro=contacts",
    "/v1/cadastros/contatos?page=1&size=100",
  ],
  ["/cadastros-reais?cadastro=warehouses", "/v1/cadastros/warehouses"],
  ["/listas-precos", "/v1/cadastros/listas-precos"],
  ["/campos-customizados", "/v1/cadastros/campos-customizados"],
  ["/tipos-contatos-empresa", "/v1/cadastros/tipos-contato"],
  ["/categorias-produtos", "/v1/cadastros/taxonomias/categorias-produtos"],
  [
    "/documentos-empresa?tipo=sales_orders",
    "/v1/documentos/sales_orders?page=1&limit=100",
  ],
  [
    "/documentos-empresa?tipo=purchase_orders",
    "/v1/documentos/purchase_orders",
  ],
  ["/historico-fiscal?modelo=55", "/v1/notas-fiscais?model=55&origin=brufap"],
  ["/naturezas-operacao", "/v1/notas-fiscais/naturezas"],
  ["/emissor-fiscal?modelo=55", "/v1/rascunhos-fiscais"],
  ["/checkin-recebimentos", "/v1/estoque/checkin/notas"],
  ["/frente-caixa-empresa", "/v1/frente-caixa"],
  ["/estoque-empresa", "/v1/posicoes-estoque"],
  ["/conferencia-estoque-empresa", "/v1/estoque/conferencias/atual"],
  ["/estoque-abertura", "/v1/politica-estoque"],
  [
    "/financeiro-empresa?area=receivable",
    "/v1/financeiro/titles?page=1&limit=100&kind=receivable&option=open",
  ],
  ["/financeiro-empresa?area=accounts", "/v1/financeiro/accounts?limit=100"],
  [
    "/financeiro-empresa?area=categories",
    "/v1/financeiro/categorias-arvore?kind=receivable",
  ],
  [
    "/financeiro-empresa?area=contas-financeiras",
    "/v1/financeiro/contas-financeiras?page=1&limit=100&situacao=ativo",
  ],
  ["/financeiro-empresa?area=controle-caixa", "/v1/financeiro/controle-caixa"],
  [
    "/financeiro-empresa?area=comissoes",
    "/v1/financeiro/comissoes?month=2026-11",
  ],
  [
    "/financeiro-empresa?area=faturamento-agrupado",
    "/v1/financeiro/faturamento-agrupado?from=2026-11-01&to=2026-11-30",
  ],
  ["/financeiro-empresa?area=remessas", "/v1/financeiro/remessa-candidatos"],
  ["/relatorio-vencimentos", "/v1/relatorios/vencimentos"],
  ["/cobranca-empresa", "/v1/cnab"],
  ["/empresa-configuracoes", "/v1/empresa"],
  [
    "/preferencias/sistema/registro-atividades",
    "/v1/registro-atividades?de=2026-11-01&ate=2026-11-16",
  ],
  ["/preferencias/sistema/gerenciador-arquivos", "/v1/gerenciador-arquivos"],
  ["/preferencias/empresa/geral", "/v1/preferencias/empresa-geral"],
  ["/preferencias/sistema/interface", "/v1/preferencias/sistema-interface"],
  ["/preferencias/cadastros/produtos", "/v1/preferencias/cadastros-produtos"],
  ["/preferencias/vendas/frente-caixa", "/v1/preferencias/vendas-frente-caixa"],
  ["/preferencias/notas-fiscais/nfe", "/v1/preferencias/notas-nfe"],
  [
    "/preferencias/financas/contas-receber",
    "/v1/preferencias/financas-receber",
  ],
];

async function setup() {
  const f = await fixture();
  await setModule(f.profile, "erp", true, f.admin.id);
  for (const id of ["erp-fiscal", "erp-cobranca", "erp-pdv"])
    await setModule(f.profile, id, true, f.admin.id);
  const send = async (request: Request) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env as any, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  const get = (token: string, path: string) =>
    send(
      new Request(`https://test/api/v1/profiles/${f.profile}${path}`, {
        headers: { Authorization: "Bearer " + token },
      }),
    );
  return { f, send, get };
}

const trace: string[] = [];
/** O controlador do painel falando com o Worker (o Bearer do teste no lugar do cookie). */
async function panel(
  send: (request: Request) => Promise<Response>,
  profile: string,
  token: string,
  actor: string,
) {
  const auth = {
    getSession: async () => ({
      data: { session: { access_token: token, user: { id: actor } } },
      error: null,
    }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signInWithPassword: async () => ({
      data: { session: null },
      error: { code: "WABOTIA_LOGIN" },
    }),
    signOut: async () => ({ error: null }),
  };
  // O workerd não aceita `cache` nem `redirect: "error"` no Request (o navegador aceita); o resto vai como o painel manda.
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const { cache: _cache, redirect: _redirect, ...rest } = init;
    try {
      const response = await send(
        new Request(new URL(String(input), "https://test"), rest),
      );
      trace.push(
        `${String(input)} → ${response.status} ${await response
          .clone()
          .text()
          .then((t) => t.slice(0, 300))}`,
      );
      return response;
    } catch (error) {
      trace.push(`${String(input)} → ${String(error)}`);
      throw error;
    }
  }) as typeof fetch;
  const controller = createAccessController(
    auth as never,
    `/api/v1/profiles/${profile}/erp`,
    fetcher,
  );
  const stop = controller.start();
  for (
    let i = 0;
    i < 200 && ["loading", "checking"].includes(controller.getSnapshot().phase);
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  const snapshot = controller.getSnapshot();
  stop();
  return snapshot;
}

describe("painel do ERP contra a rota real", () => {
  it(
    "a lista 'em implantação' é o que a rota ainda não responde",
    { timeout: 300_000 },
    async () => {
      const { f, get } = await setup();
      const token = await bearer(f.admin);
      setMotorReal(true);
      const wrong: string[] = [];
      try {
        for (const [screen, path] of SCREENS) {
          const response = await get(token, `/erp${path}`);
          const body = await response.json<any>().catch(() => null);
          const ok = response.status < 300;
          if (ok === pendingInMotor(screen))
            wrong.push(
              `${screen} → ${path}: ${response.status} ${body?.error?.code ?? ""} (${ok ? "responde: tire de web/erp/motor.ts" : "sem motor: ponha em web/erp/motor.ts"})`,
            );
        }
      } finally {
        setMotorReal(false);
      }
      expect(wrong, wrong.join("\n")).toEqual([]);
    },
  );

  it(
    "o controlador do painel entra com erp:admin e, sem papel, fica aguardando liberação",
    { timeout: 120_000 },
    async () => {
      const { f, send } = await setup();
      const admin = await panel(
        send,
        f.profile,
        await bearer(f.admin),
        f.admin.id,
      );
      expect(admin.phase, JSON.stringify(admin) + "\n" + trace.join("\n")).toBe(
        "ready",
      );
      expect(admin.membership?.role).toBe("admin");
      await exec(
        env,
        "UPDATE users SET access=? WHERE id=?",
        JSON.stringify(["*"]),
        f.member.id,
      );
      const none = await panel(
        send,
        f.profile,
        await bearer(f.member),
        f.member.id,
      );
      expect(none.phase, JSON.stringify(none)).toBe("pending");
      expect(none.message).toBeNull();
    },
  );

  it(
    "as pessoas com papel no ERP vêm de /people",
    { timeout: 120_000 },
    async () => {
      const { f, get } = await setup();
      await exec(
        env,
        "UPDATE users SET access=? WHERE id=?",
        JSON.stringify(["erp:vendas"]),
        f.member.id,
      );
      const response = await get(await bearer(f.admin), "/people");
      expect(response.status).toBe(200);
      const people = erpPeople(await response.json());
      expect(
        people.find((p) => p.user_id === f.admin.id.toLowerCase())?.role,
      ).toBe("admin");
      expect(
        people.find((p) => p.user_id === f.member.id.toLowerCase())?.role,
      ).toBe("vendas");
    },
  );
});
