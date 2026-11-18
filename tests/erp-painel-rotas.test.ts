// O painel do ERP (web/erp) contra a rota real do ERP no Worker.
// 1. A lista de telas "em implantação" (web/erp/motor.ts) é a que a rota
//    responde de fato: cada tela da lista tem a primeira leitura sem motor
//    ainda (502 do RPC não portado, 404); cada tela fora dela responde 2xx.
//    Quando um domínio for portado, este teste manda tirar a tela da lista.
// 2. O controlador do painel (web/erp/app/lib/real-access.ts) entra com o
//    administrador (erp:admin) e, sem papel erp:*, fica em "aguardando
//    liberação" (403 erp_role_required).
// 3. As pessoas com papel no ERP vêm de /people (web/erp/people.ts).
// 4. Uma ação de tela que o motor ainda não faz (0A000) aciona o aviso de
//    implantação da casca (web/erp/motor.ts, setActionPendingNotice).
// 5. A exportação da empresa percorre o caminho do botão "Baixar" (pedir,
//    concluir, link, download) com o validador do próprio painel.
import {
  createExecutionContext,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { exec } from "../src/db";
import { bearer, fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";
import {
  MOTOR_PENDING_READS,
  pendingInMotor,
  readPendingInMotor,
  setActionPendingNotice,
  setMotorReal,
} from "../web/erp/motor";
import { erpPeople } from "../web/erp/people";
import {
  STORED_PREFERENCE_PAGES,
  preferencePageHref,
} from "../packages/erp-domain/src/preferences/catalog.mjs";
import { parsePreferencesPage } from "../packages/erp-domain/src/preferences/dto.mjs";
import {
  AccessError,
  createAccessController,
} from "../web/erp/app/lib/real-access";
import {
  EXPORTS_PATH,
  exportLinkPath,
  parseExportLink,
  parseExports,
  type CompanyExport,
} from "../web/erp/app/lib/platform-model";
import { erpStub } from "../src/erp/hub";
import { emissorBadge, type EmissorView } from "../web/erp/emissor";

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
    "/documentos-empresa?tipo=sales_orders&acao=relatorios&relatorio=vendas",
    "/v1/documentos/sales_orders/relatorio-vendas/opcoes",
  ],
  [
    "/documentos-empresa?tipo=sales_orders&acao=relatorios&relatorio=romaneio",
    "/v1/documentos/sales_orders/romaneio?from=2026-11-01&to=2026-11-17",
  ],
  [
    "/documentos-empresa?tipo=sales_orders&acao=relatorios&relatorio=curva-abc",
    "/v1/documentos/sales_orders/curva-abc?from=2026-11-01&to=2026-11-17",
  ],
  ["/grupos-produtos", "/v1/cadastros/taxonomias/grupos-produtos"],
  ["/tags", "/v1/cadastros/taxonomias/tags"],
  ["/grupos-tags", "/v1/cadastros/taxonomias/grupos-tags"],
  ["/numeracao-contatos", "/v1/cadastros/contatos/codigo"],
  [
    "/documentos-empresa?tipo=sales_orders",
    "/v1/documentos/sales_orders?page=1&limit=100",
  ],
  [
    "/documentos-empresa?tipo=purchase_orders",
    "/v1/documentos/purchase_orders",
  ],
  [
    "/documentos-empresa?tipo=sales_proposals",
    "/v1/documentos/sales_proposals?page=1&limit=100",
  ],
  [
    "/documentos-empresa?tipo=service_orders",
    "/v1/documentos/service_orders?page=1&limit=100",
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
  [
    "/financeiro-empresa?area=remessas",
    "/v1/financeiro/remessas?page=1&limit=50",
  ],
  [
    "/financeiro-empresa?area=retornos",
    "/v1/financeiro/retornos?page=1&limit=50",
  ],
  ["/relatorio-vencimentos", "/v1/relatorios/vencimentos"],
  ["/cobranca-empresa", "/v1/cnab"],
  ["/cobranca-operacional", "/v1/cobranca-operacional"],
  ["/retornos-operacionais", "/v1/retornos-operacionais"],
  ["/preferencias/backup/exportacao", "/v1/plataforma/exportacoes"],
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

/**
 * Todas as leituras que as telas levantadas (sessao-M-erp-latencia.md) fazem
 * ao abrir: barra do topo, Início, Produtos e Contas a receber. Cada uma
 * responde 2xx ou está em MOTOR_PENDING_READS (web/erp/motor.ts).
 */
const OPEN_READS: [string, string][] = [
  ["barra", "/v1/sistema/perfil"],
  ["barra", "/v1/sistema/armazenamento"],
  ["barra", "/v1/sistema/notificacoes?aba=nao_lidas"],
  ["barra", "/v1/preferencias/sistema-interface"],
  ["Início", "/v1/inicio"],
  ["Início", "/v1/sistema/validade"],
  ["Início", "/v1/inicio/atalhos"],
  ["Início", "/v1/sistema/graficos-inicio"],
  ["Produtos", "/v1/cadastros"],
  ["Produtos", "/v1/cadastros/taxonomias/categorias-produtos"],
  ["Produtos", "/v1/cadastros/taxonomias/grupos-tags"],
  ["Produtos", "/v1/cadastros/taxonomias/tags"],
  ["Produtos", "/v1/preferencias/cadastros-produtos"],
  ["Produtos", "/v1/preferencias-listas/cadastros.produtos"],
  ["Produtos", "/v1/documentos/sacola-vendas"],
  ["Produtos", "/v1/cadastros/products?page=1&size=100&situation=latest"],
  ["Produtos (filtro de estoque)", "/v1/posicoes-estoque/depositos?limit=100"],
  ["Pedidos de venda", "/v1/documentos"],
  ["Pedidos de venda", "/v1/documentos/sales_orders/situacoes"],
  ["Pedidos de venda", "/v1/documentos/sales_orders/preferencias-listagem"],
  ["Pedidos de venda", "/v1/preferencias/vendas-vendas"],
  ["Pedidos de venda", "/v1/documentos/sales_orders/categorias"],
  ["Contas a receber", "/v1/financeiro"],
  [
    "Contas a receber",
    "/v1/financeiro/titles?page=1&limit=100&kind=receivable&option=open",
  ],
  ["Contas a receber", "/v1/financeiro/accounts?limit=100"],
  ["Contas a receber", "/v1/preferencias/financas-receber"],
  ["Contas a receber", "/v1/preferencias-listas/financeiro.contas_receber"],
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
  use?: (controller: ReturnType<typeof createAccessController>) => Promise<void>,
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
  // Até 15 s para o /v1/me: com a máquina carregada, o workerd demora a responder.
  for (
    const until = Date.now() + 15_000;
    Date.now() < until &&
    ["loading", "checking"].includes(controller.getSnapshot().phase);

  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  const snapshot = controller.getSnapshot();
  try {
    await use?.(controller);
  } finally {
    stop();
  }
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
    "as leituras de abertura respondem ou estão na lista de leituras sem motor",
    { timeout: 300_000 },
    async () => {
      const { f, get } = await setup();
      const token = await bearer(f.admin);
      setMotorReal(true);
      const wrong: string[] = [];
      const failing: string[] = [];
      try {
        for (const [screen, path] of OPEN_READS) {
          const response = await get(token, `/erp${path}`);
          const body = await response.json<any>().catch(() => null);
          const ok = response.status < 300;
          if (!ok) failing.push(path);
          if (ok === readPendingInMotor(path))
            wrong.push(
              `${screen}: ${path} → ${response.status} ${body?.error?.code ?? ""} (${ok ? "responde: tire de MOTOR_PENDING_READS" : "sem motor: ponha em MOTOR_PENDING_READS ou trate na tela"})`,
            );
        }
        for (const pattern of MOTOR_PENDING_READS)
          if (!failing.some((path) => pattern.test(path)))
            wrong.push(
              `${pattern}: nenhuma leitura sem motor confere; tire de MOTOR_PENDING_READS`,
            );
      } finally {
        setMotorReal(false);
      }
      expect(wrong, wrong.join("\n")).toEqual([]);
    },
  );

  it(
    "toda página de preferências de uma instalação nova passa no validador do painel",
    { timeout: 300_000 },
    async () => {
      // O motor valida com a cópia dele (src/erp/fagoo/packages); a tela, com a do
      // painel (packages/). Um padrão diferente na versão 0 só aparece aqui.
      const { f, get } = await setup();
      const token = await bearer(f.admin);
      setMotorReal(true);
      const wrong: string[] = [];
      try {
        for (const page of STORED_PREFERENCE_PAGES) {
          if (pendingInMotor(preferencePageHref(page))) continue;
          const response = await get(token, `/erp/v1/preferencias/${page.id}`);
          const raw = await response.json<any>().catch(() => null);
          if (response.status >= 300) {
            wrong.push(
              `${page.id}: ${response.status} ${raw?.error?.code ?? ""}`,
            );
            continue;
          }
          try {
            parsePreferencesPage(raw, page.id);
          } catch (error) {
            wrong.push(
              `${page.id}: o painel recusa a resposta (${String(error)})`,
            );
          }
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
    "ação de tela sem motor (0A000) avisa a casca em vez de só falhar",
    { timeout: 120_000 },
    async () => {
      // Aplicar importação do Catálogo (erp_catalog_import_apply) não está registrado.
      // O POST /v1/importacao-cadastros/products/apply chama o RPC sem leitura prévia.
      const { f, send, get } = await setup();
      // Primeira ida ao motor no isolado (rodando só este teste): fora da espera do controlador.
      await get(await bearer(f.admin), "/erp/v1/inicio");
      const seen: string[] = [];
      setMotorReal(true);
      setActionPendingNotice(() => seen.push("aviso"));
      try {
        await panel(
          send,
          f.profile,
          await bearer(f.admin),
          f.admin.id,
          async (controller) => {
            const failure = await controller
              .catalogImport(
                "/v1/importacao-cadastros/products/apply",
                {
                  method: "POST",
                  body: { command_id: crypto.randomUUID(), preview_hash: "0".repeat(64), items: [{ source_id: "1", source_hash: "0".repeat(64) }] },
                },
              )
              .then(
                () => null,
                (error) => error,
              );
            expect(failure).toBeInstanceOf(AccessError);
            expect(
              [failure.status, failure.code],
              trace.slice(-3).join("\n"),
            ).toEqual([
              502,
              "ERP_UPSTREAM_UNAVAILABLE",
            ]);
          },
        );
      } finally {
        setActionPendingNotice(null);
        setMotorReal(false);
      }
      expect(seen).toEqual(["aviso"]);
    },
  );

  it(
    "exportação da empresa pelo painel: pedir, concluir, link e download",
    { timeout: 180_000 },
    async () => {
      // O caminho do botão "Baixar" (CompanyExport.tsx): o painel lê cada
      // resposta da rota real com o próprio validador. Um nome ou endereço que
      // o motor mude e o painel não aceite aparece aqui.
      const { f, send, get } = await setup();
      await get(await bearer(f.admin), "/erp/v1/inicio");
      setMotorReal(true);
      try {
        await panel(
          send,
          f.profile,
          await bearer(f.admin),
          f.admin.id,
          async (controller) => {
            const asked = (await controller.platform!(EXPORTS_PATH, {
              method: "POST",
              body: { command_id: crypto.randomUUID() },
            })) as { export: { id: string }; view: unknown };
            const id = asked.export.id;
            parseExports(asked.view);
            // O pedido acorda o agendador; o teste roda os alarmes que o
            // objeto agenda, no horário de cada um (relógio do objeto adiantado
            // só durante a rodada, como em tests/erp-do-scheduler.test.ts).
            const stub = () => erpStub(env, f.profile);
            let item: CompanyExport | undefined;
            for (let i = 0; i < 6 && item?.status !== "ready"; i++) {
              const next = await runInDurableObject(
                stub(),
                (_i: unknown, s: DurableObjectState) => s.storage.getAlarm(),
              );
              if (next === null) break;
              vi.useFakeTimers({ toFake: ["Date"] });
              vi.setSystemTime(Math.max(next, Date.now()));
              try {
                await runDurableObjectAlarm(stub());
              } finally {
                vi.useRealTimers();
              }
              item = parseExports(
                await controller.platform!(EXPORTS_PATH, { method: "GET" }),
              ).items.find((e) => e.id === id);
            }
            expect(item?.status, JSON.stringify(item)).toBe("ready");
            const link = parseExportLink(
              await controller.platform!(exportLinkPath(id), {
                method: "POST",
                body: {},
              }),
              "https://test",
            );
            expect(link.filename).toMatch(/^wabotia-exportacao-.+\.zip$/);
            const download = await send(new Request(link.url));
            expect(download.status).toBe(200);
            const bytes = new Uint8Array(await download.arrayBuffer());
            expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]); // ZIP
          },
        );
      } finally {
        setMotorReal(false);
      }
    },
  );

  it(
    "Importar contatos: a simulação da planilha responde, e a tela está no menu",
    { timeout: 120_000 },
    async () => {
      // A tela lê os tipos de contato e manda as linhas em simulação
      // (dry_run) antes de gravar (RealImportContacts.tsx).
      const { f, send } = await setup();
      const response = await send(
        new Request(
          `https://test/api/v1/profiles/${f.profile}/erp/v1/cadastros/contatos/importar`,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + (await bearer(f.admin)),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              dry_run: true,
              rows: [{ row: 2, data: { name: "Ana Souza" } }],
            }),
          },
        ),
      );
      const body = await response.json<any>().catch(() => null);
      setMotorReal(true);
      try {
        expect(
          response.status < 300,
          `${response.status} ${JSON.stringify(body)}`,
        ).toBe(!pendingInMotor("/importar-contatos"));
      } finally {
        setMotorReal(false);
      }
    },
  );

  it(
    "o selo do emissor lê a rota real: sem cofre, 'Emissão não configurada'",
    { timeout: 120_000 },
    async () => {
      // A Frente de caixa mostrava "Certificado inválido" (o A1 do Fagoo); no
      // Wabotia o certificado fica no cofre NFapi (web/erp/emissor.ts).
      const { f, get } = await setup();
      const response = await get(await bearer(f.admin), "/erp-emissor");
      expect(response.status).toBe(200);
      const view = await response.json<EmissorView>();
      expect(view.configured).toBe(false);
      expect(emissorBadge(view)?.text).toBe("Emissão não configurada");
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
