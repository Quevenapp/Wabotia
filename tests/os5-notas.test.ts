// OS, parte 5: notas da ordem de serviço no lado do Worker (rota, inventário
// dos bots, marca "exigir nota para entregar" e a conferência na entrega).
// Sem cofre, governo ou ERP real: o motor e o cofre simulado estão em
// tests/erp/comnfe/os5-notas.test.mjs.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec } from "../src/db";
import { perform } from "../src/service";
import { uid } from "../src/types";
import { commercialNfeRoute } from "../src/erp/commercial-nfe/routes.ts";
import { OS_NOTE_OPERATIONS } from "../src/erp/commercial-nfe/os-notes-metadata.ts";
import { ERP_BOT_OPERATIONS } from "../src/modules/erp/bot-access.ts";
import { rememberOsNotes, requireInvoiceToDeliver } from "../src/modules/os/fiscal/notes.ts";
import { com1Actor, com1Identity, com1NoIoEnv, com1RouteDependencies } from "./com1-support";
import { fixture } from "./service-center-fixture";

const ORDER = "88888888-8888-4888-8888-888888888888";
const request = (path: string, method = "GET", body?: object) => new Request(`https://wabotia.invalid/api/v1/profiles/com1/erp-comercial-nfe/${path}`, {
  method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
});
const route = (input: Request, options: { parts?: Record<string, boolean>; role?: string } = {}) => {
  const actor = com1Actor();
  const identity = com1Identity(actor, options.parts ?? {});
  if (options.role) identity.actor = { ...identity.actor!, erp_role: options.role as never };
  const seen: string[] = [];
  return { seen, response: commercialNfeRoute(com1NoIoEnv, input, "com1", actor, { ...com1RouteDependencies({ identity }),
    handle: async context => { seen.push(context.operation.name); return Response.json({ ok: true, input: context.input, id: context.params.id }); } }) };
};

describe("OS5: rota das notas da ordem", () => {
  it("emitir passa o tipo da nota e o id da ordem; tipo desconhecido é recusado", async () => {
    const ok = route(request(`os/${ORDER}/notas/emitir`, "POST", { command_id: uid(), kind: "nfse" }));
    const response = await ok.response;
    expect(response.status).toBe(200);
    expect(ok.seen).toEqual(["osnota.emit"]);
    expect(await response.json()).toMatchObject({ id: ORDER, input: { kind: "nfse" } });
    const bad = await route(request(`os/${ORDER}/notas/emitir`, "POST", { command_id: uid(), kind: "nfce" })).response;
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "fiscal_invalid_request" });
    const reason = await route(request(`os/${ORDER}/notas/cancelar`, "POST", { command_id: uid(), kind: "nfe", justification: "Nota emitida com erro de valor.", reason: "erro_emissao" })).response;
    expect(reason.status).toBe(400);
  });

  it("Fiscal desligado recusa com o módulo a ligar; a nota de peças pede Vendas e Produtos; a de serviço não", async () => {
    const off = await route(request(`os/${ORDER}/notas`), { parts: { fiscal: false } }).response;
    expect(off.status).toBe(409);
    expect(await off.json()).toMatchObject({ code: "module_disabled", message: expect.stringContaining("parte Fiscal") });
    const parts = await route(request(`os/${ORDER}/notas/emitir`, "POST", { command_id: uid(), kind: "nfe" }), { parts: { sales: false } }).response;
    expect(parts.status).toBe(409);
    expect(await parts.json()).toMatchObject({ code: "module_disabled", message: expect.stringContaining("Vendas e Produtos") });
    const service = route(request(`os/${ORDER}/notas/emitir`, "POST", { command_id: uid(), kind: "nfse" }), { parts: { sales: false, products: false } });
    expect((await service.response).status).toBe(200);
    expect(service.seen).toEqual(["osnota.emit"]);
  });

  it("papel de consulta lê as notas mas não emite nem cancela", async () => {
    expect((await route(request(`os/${ORDER}/notas`), { role: "consulta" }).response).status).toBe(200);
    const denied = await route(request(`os/${ORDER}/notas/emitir`, "POST", { command_id: uid(), kind: "nfse" }), { role: "consulta" }).response;
    expect(denied.status).toBe(403);
  });
});

describe("OS5: inventário dos bots", () => {
  it("emitir, consultar e cancelar as notas da ordem são operações sensíveis do grupo nfe, com descrição em português", () => {
    for (const name of ["osnota.emit", "osnota.consult", "osnota.cancel", "nfse.config.save"]) {
      const op = ERP_BOT_OPERATIONS.find(item => item.id === name)!;
      expect(op).toMatchObject({ group: "nfe", sensitive: true });
      expect(op.description).toMatch(/Fiscal/);
      expect(op.path.startsWith("erp-comercial-nfe/")).toBe(true);
    }
    expect(ERP_BOT_OPERATIONS.find(item => item.id === "osnota.list")).toMatchObject({ group: "nfe", sensitive: false });
    expect(OS_NOTE_OPERATIONS.map(op => op.name)).toEqual(expect.arrayContaining(["osnota.list", "osnota.emit", "osnota.consult", "osnota.cancel", "osnota.xml", "osnota.pdf"]));
  });
});

describe("OS5: exigir nota para entregar", () => {
  it("com Fiscal ligado, só entrega com nota autorizada anotada; com Fiscal desligado a marca não vale", async () => {
    const f = await fixture();
    const run = (op: string, data: any = {}) => perform(env, f.admin, f.profile, op, data, uid());
    await run("module.set", { id: "os", enabled: true });
    // Sem o ERP (Fiscal desligado), a ordem funciona como antes.
    await expect(requireInvoiceToDeliver(env, f.profile, ORDER)).resolves.toBeUndefined();
    await run("module.set", { id: "erp", enabled: true });
    await run("module.set", { id: "erp-fiscal", enabled: true });
    await expect(requireInvoiceToDeliver(env, f.profile, ORDER)).rejects.toMatchObject({ code: "invoice_required", status: 409 });
    await rememberOsNotes(env, f.profile, ORDER, [{ kind: "nfse", emission: { id: uid(), status: "processando", number: 12, protocol: null, environment: "homologacao" } }]);
    await expect(requireInvoiceToDeliver(env, f.profile, ORDER)).rejects.toMatchObject({ code: "invoice_required" });
    await rememberOsNotes(env, f.profile, ORDER, [{ kind: "nfse", emission: { id: uid(), status: "autorizada", number: 12, protocol: "126", environment: "homologacao" } }]);
    await expect(requireInvoiceToDeliver(env, f.profile, ORDER)).resolves.toBeUndefined();
    // Nota cancelada deixa de valer para a entrega.
    await rememberOsNotes(env, f.profile, ORDER, [{ kind: "nfse", emission: { id: uid(), status: "cancelada", number: 12, protocol: "126", environment: "homologacao" } }]);
    await expect(requireInvoiceToDeliver(env, f.profile, ORDER)).rejects.toMatchObject({ code: "invoice_required" });
    await exec(env, "DELETE FROM os_fiscal_notes WHERE profile_id=?", f.profile);
  });
});
