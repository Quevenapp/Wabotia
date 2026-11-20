// OS4: rotas do contrato de manutenção e da execução agendada. Nomes estáveis
// e descrições no OpenAPI do módulo (src/modules/openapi.ts, workMotorContract).
// Dinheiro e encerramento (criar, editar, mudar a situação do contrato, abrir
// a visita e marcar/desmarcar a ordem coberta) são sensíveis para o bot: a
// pessoa confirma a proposta (definition.ts, bot.sensitive).
import { ApiError, type Actor } from "../../../types";
import { isBound } from "../../../visibility";
import { onCommand, onRead, onRoute, type ModuleContext } from "../../api";
import {
  contractHistory,
  contractOptions,
  contractView,
  coverOrder,
  createContract,
  listContracts,
  loadContract,
  maintenanceDue,
  openVisit,
  orderContractView,
  releaseCoverage,
  requireContracts,
  setContractStatus,
  updateContract,
  type ContractView,
} from "./store";
import { cancelSchedule, getSchedule, mySchedule, scheduleOptions, scheduleSlots, setSchedule } from "./schedule";

/** Sem contacts:read, a aplicação não vê o telefone do cliente do contrato. */
function visible<T extends { customer?: ContractView["customer"] }>(ctx: ModuleContext, actor: Actor, view: T): T {
  if (ctx.mayRead(actor, "contacts") || !view.customer) return view;
  return { ...view, customer: { ...view.customer, phone: null } };
}
function visibleList<T extends { contract?: ContractView }>(ctx: ModuleContext, actor: Actor, list: T[]) {
  return list.map(item => item.contract ? { ...item, contract: visible(ctx, actor, item.contract) } : visible(ctx, actor, item as any));
}

export const MAINTENANCE_OPERATIONS = {
  sensitive: ["os.contract.create", "os.contract.update", "os.contract.status", "os.contract.visit", "os.contract.cover", "os.contract.release"],
};

/** Como a ordem (authorizedOrder): credencial de registro e ator preso à conversa não listam contratos da área. */
function requireAreaReader(actor: Actor) {
  if (actor.credential || isBound(actor)) throw new ApiError(404, "not_found", "Contrato não encontrado.");
}

export function registerMaintenance() {
  onRead("os", "service-orders/contract-options", async (ctx, actor) => {
    ctx.access(actor, "conversations:read");
    return contractOptions(ctx);
  });
  onRead("os", "service-orders/contracts", async (ctx, actor, { query }) => {
    ctx.access(actor, "conversations:read");
    requireAreaReader(actor);
    await requireContracts(ctx);
    const page = await listContracts(ctx, query);
    return { ...page, data: page.data.map(view => visible(ctx, actor, view)) };
  });
  onRead("os", "service-orders/contracts/:contract_id", async (ctx, actor, { params }) => {
    ctx.access(actor, "conversations:read");
    requireAreaReader(actor);
    await requireContracts(ctx);
    const view = await contractView(ctx, await loadContract(ctx, params.contract_id));
    const history = ctx.mayRead(actor, "notes") ? await contractHistory(ctx, params.contract_id) : [];
    return { ...visible(ctx, actor, view), history };
  });
  onRead("os", "service-orders/maintenance-due", async (ctx, actor) => {
    ctx.access(actor, "conversations:read");
    requireAreaReader(actor);
    await ctx.requireEnabled();
    const due = await maintenanceDue(ctx);
    return { ...due, data: visibleList(ctx, actor, due.data) };
  });
  onRead("os", "service-orders/schedule-options", (ctx, actor) => scheduleOptions(ctx, actor));
  onRead("os", "service-orders/schedule-slots", (ctx, actor, { query }) => scheduleSlots(ctx, actor, query));
  onRead("os", "service-orders/my-schedule", (ctx, actor, { query }) => mySchedule(ctx, actor, query));
  onRead("os", "service-orders/:id/contract", async (ctx, actor, { params }) => {
    const view = await orderContractView(ctx, actor, params.id);
    return { ...view, contracts: view.contracts.map(c => visible(ctx, actor, c)) };
  });
  onRead("os", "service-orders/:id/schedule", (ctx, actor, { params }) => getSchedule(ctx, actor, params.id));

  const writes: ["POST" | "PATCH" | "PUT", string, string, (ctx: ModuleContext, actor: Actor, data: any, requestId: string) => Promise<any>][] = [
    ["POST", "service-orders/contracts", "os.contract.create", (ctx, actor, data, requestId) => createContract(ctx, actor, data, requestId)],
    ["PATCH", "service-orders/contracts/:contract_id", "os.contract.update", (ctx, actor, data) => updateContract(ctx, actor, data.contract_id, data)],
    ["POST", "service-orders/contracts/:contract_id/situation", "os.contract.status", (ctx, actor, data) => setContractStatus(ctx, actor, data.contract_id, data)],
    ["POST", "service-orders/contracts/:contract_id/visits", "os.contract.visit", (ctx, actor, data, requestId) => openVisit(ctx, actor, data.contract_id, data, requestId)],
    ["POST", "service-orders/:id/contract-coverage", "os.contract.cover", (ctx, actor, data, requestId) => coverOrder(ctx, actor, data.id, data, requestId)],
    ["POST", "service-orders/:id/contract-coverage/release", "os.contract.release", (ctx, actor, data) => releaseCoverage(ctx, actor, data.id, data)],
    ["PUT", "service-orders/:id/schedule", "os.schedule.set", (ctx, actor, data, requestId) => setSchedule(ctx, actor, data.id, data, requestId)],
    ["POST", "service-orders/:id/schedule/cancel", "os.schedule.cancel", (ctx, actor, data) => cancelSchedule(ctx, actor, data.id, data)],
  ];
  for (const [method, path, op, handler] of writes) {
    onRoute("os", { method, path, op });
    onCommand("os", op, async (ctx, actor, data, { requestId }) => {
      ctx.access(actor, "conversations:write");
      requireAreaReader(actor);
      const result = await handler(ctx, actor, data, requestId);
      return result && typeof result === "object" && "customer" in result ? visible(ctx, actor, result) : result;
    });
  }
}
