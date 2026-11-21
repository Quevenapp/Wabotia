/** Fatia D, a parte do contrato que roda no Worker: o contrato de manutenção é
 * do módulo Ordem de Serviço do Vinki (banco do núcleo, Coordinator da área),
 * fora do objeto do ERP. Aqui só se lê a prévia conferida no ERP, se confere o
 * módulo e se chama o comando do próprio módulo (os.contract.create, sem mudar
 * as regras dele), com a cobrança recorrente desligada; o vínculo volta ao ERP.
 * Nada aqui escreve no Bling. */
import type { Actor, Env } from "../../types";
import { BlingAdoptionError, type BlingAdoptionOperationMap } from "./adoption-contracts.ts";
import type { BlingExtrasContractDraft } from "./extras-contracts.ts";

type Forward = (name: "erp_bling_extras_contract_options" | "erp_bling_extras_contract_link", input: unknown) => Promise<Response>;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const digits = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "");

async function options(env: Env, profile: string) {
  const [{ moduleEnabled }, { mensalidadeAvailable, plansForContract }] = await Promise.all([import("../../modules/registry"), import("../../modules/mensalidade/public")]);
  const os = !!await moduleEnabled(env, profile, "os"), mensalidade = !!await mensalidadeAvailable(env, profile);
  const plans = mensalidade ? (await plansForContract(env, profile) as Record<string, unknown>[]).map(plan => ({
    id: String(plan.id), name: String(plan.name ?? "").slice(0, 200), amount_cents: Math.max(0, Math.trunc(Number(plan.amount_cents ?? 0)) || 0), period_label: String(plan.period_label ?? "").slice(0, 80),
  })) : [];
  return { os, mensalidade, plans, missing: !os ? "Ligue o módulo Ordem de Serviço em Gestão → Módulos para criar o contrato de manutenção." : !mensalidade ? "Ligue o módulo Mensalidade em Gestão → Módulos: o contrato de manutenção usa um plano dela." : null };
}
/** Clientes do atendimento (contatos da equipe) pelo telefone do Bling ou pela busca da pessoa. */
async function customers(env: Env, actor: Actor, profile: string, draft: BlingExtrasContractDraft, q?: string) {
  const { listContacts } = await import("../../contacts");
  const term = q ?? (digits(draft.customer.phone).length >= 8 ? digits(draft.customer.phone) : draft.customer.name ?? "");
  if (!term) return [];
  try {
    const found = await listContacts(env, actor, profile, { q: term, namespace: "team", identity: "all", limit: "20" }) as { data?: Record<string, unknown>[] };
    return (found.data ?? []).filter(c => !c.merged_into && (!c.namespace || c.namespace === "team") && (!c.identity_state || c.identity_state === "active") && c.name)
      .slice(0, 20).map(c => ({ id: String(c.id), name: String(c.name).slice(0, 200), phone: c.phone ? String(c.phone).slice(0, 40) : null }));
  } catch { return []; }
}
async function body<T>(response: Response): Promise<T> { return await response.json() as T; }

export async function handleExtrasWorker(env: Env, profile: string, actor: Actor, name: string, input: Record<string, unknown>, forward: Forward): Promise<Response> {
  if (name === "erp_bling_extras_contract_options") {
    const response = await forward("erp_bling_extras_contract_options", input);
    if (!response.ok) return response;
    const result = await body<BlingAdoptionOperationMap["erp_bling_extras_contract_options"]["output"]>(response);
    const modules = await options(env, profile);
    return Response.json({ ...result, modules: { os: modules.os, mensalidade: modules.mensalidade }, missing: modules.missing, plans: modules.plans,
      contacts: modules.os ? await customers(env, actor, profile, result.draft, typeof input.q === "string" ? input.q : undefined) : [] }, { headers });
  }
  // Criar: só a pessoa (administrador do ERP), pela tela.
  if (actor.kind !== "user" || actor.via) throw new BlingAdoptionError("BLING_ADOPTION_SCOPE_REQUIRED");
  const create = input as BlingAdoptionOperationMap["erp_bling_extras_contract_create"]["input"];
  const read = await forward("erp_bling_extras_contract_options", { source_id: create.source_id });
  if (!read.ok) return read;
  const draft = (await body<BlingAdoptionOperationMap["erp_bling_extras_contract_options"]["output"]>(read)).draft;
  if (draft.link) return Response.json({ outcome: "linked", contract_id: draft.link.contract_id, number: draft.link.number, message: "Este contrato do Bling já virou contrato de manutenção." }, { headers });
  if (draft.version !== create.version) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "O contrato mudou no Bling depois da conferência. Confira de novo antes de criar.");
  // Sem cliente ou sem início não dá para criar; valor e periodicidade vêm do plano escolhido.
  const blocking = draft.problems.filter(p => /cliente|início|excluído|data final/.test(p));
  if (blocking.length) throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", blocking.join(" "));
  const modules = await options(env, profile);
  if (modules.missing) throw new BlingAdoptionError("BLING_ADOPTION_PART_DISABLED", modules.missing);
  if (!modules.plans.some(plan => plan.id === create.plan_id)) throw new BlingAdoptionError("BLING_ADOPTION_INVALID", "Escolha um plano ativo da Mensalidade.");
  const terms = [`Vindo do Bling: contrato${draft.number ? ` nº ${draft.number}` : ""} (id ${draft.source_id}).`, draft.description,
    draft.value ? `Valor no Bling: ${draft.value}${draft.periodicity ? ` (${draft.periodicity})` : ""}.` : null].filter(Boolean).join(" ").slice(0, 4000);
  const data = {
    contact_id: create.contact_id, plan_id: create.plan_id, starts_on: draft.starts_on, ends_on: draft.ends_on, customer_name: draft.customer.name ?? undefined,
    coverage: { unit: "visits", limit: create.visits_per_period, period: create.period, excess: "quote", excess_unit_cents: null, type_ids: [], services: draft.description ?? "" },
    // A cobrança recorrente nasce desligada: a pessoa liga na tela do contrato.
    create_subscription: false, terms,
  };
  const key = `bling-contract:${profile}:${create.source_id}:${create.version}`;
  const response = await env.COORDINATOR.get(env.COORDINATOR.idFromName(profile)).fetch("https://coordinator/command", {
    method: "POST", body: JSON.stringify({ profile, operation: "os.contract.create", actor, data, key, requestId: key }),
  });
  const created = await response.json().catch(() => null) as Record<string, any> | null;
  if (!response.ok) {
    const error = created?.error ?? created ?? {};
    const code = typeof error.code === "string" ? error.code : "";
    throw new BlingAdoptionError(code === "module_disabled" ? "BLING_ADOPTION_PART_DISABLED" : "BLING_ADOPTION_RECORD_REFUSED",
      typeof error.message === "string" ? `Ordem de Serviço: ${error.message}`.slice(0, 590) : "O módulo Ordem de Serviço não criou o contrato. Confira os dados e tente de novo.");
  }
  const contract = created ?? {};
  const contractId = String(contract.id ?? ""), number = contract.display_number ?? contract.number ?? null;
  const linked = await forward("erp_bling_extras_contract_link", { command_id: create.command_id, source_id: create.source_id, version: create.version, contract_id: contractId, ...(number != null ? { number: String(number).slice(0, 40) } : {}) });
  if (!linked.ok) return linked;
  return Response.json({ outcome: "created", contract_id: contractId, number: number == null ? null : String(number).slice(0, 40),
    message: `Contrato de manutenção ${number ?? ""} criado, com a cobrança recorrente desligada. Ligue a cobrança na tela do contrato quando quiser cobrar.`.replace("  ", " ") }, { headers });
}
