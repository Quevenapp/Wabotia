// Para o contador: rotas /erp-contador (src/erp/contador/routes.ts), o objeto
// do ERP da área (pacote montado no alarme, partes no R2 da instalação de
// teste) e o link de 7 dias. Só cofre simulado; o envio pelo WhatsApp e por
// e-mail esbarra na falta de linha e de e-mail e fica registrado como falhou.
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../../../src/db";
import { sha } from "../../../src/security";
import { uid, type Actor } from "../../../src/types";
import { erpContadorRoute } from "../../../src/erp/contador/routes.ts";
import { contadorPublicDownload, runAutoSend } from "../../../src/erp/contador/service.ts";
import { readStoredZip } from "../../../src/erp/contador/zip.ts";
import { createNfapiProvider } from "../../../src/erp/emissor/nfapi-provider.ts";
import { setModule } from "../../erp-module-helper";
import { fixture } from "../../service-center-fixture";
import { requestExample } from "../emissor/schema";
import { actor, example, member, vaultArea } from "../emissor/helpers";

const url = (profile: string, sub: string) => `https://wabotia.test/api/v1/profiles/${profile}/erp-contador${sub}`;
const provider = createNfapiProvider({ delays: [0, 0, 0] });
const DAY = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);

async function area(options: { vault?: boolean } = {}) {
  // Sem cofre: uma área completa (linhas de WhatsApp, pessoas), como nos testes do envio pela conversa.
  const a = options.vault ? await vaultArea() : { profile: (await fixture()).profile, vault: null as any, ctx: null as any };
  await setModule(a.profile, "erp", true, "teste");
  await setModule(a.profile, "erp-fiscal", true, "teste");
  if (options.vault) await provider.emit(a.ctx, "nfe", example(requestExample("POST", "/v1/nfe")), { document_id: uid(), version: 1 });
  const call = (who: Actor, method: string, sub: string, body?: unknown) =>
    erpContadorRoute(env, new Request(url(a.profile, sub), { method, body: body === undefined ? undefined : JSON.stringify(body) }), a.profile, who,
      options.vault ? { fetch: a.vault.fetch } : {});
  const audits = () => env.DB.prepare("SELECT operation, resource_id FROM audit WHERE profile_id=? ORDER BY rowid").bind(a.profile).all<{ operation: string; resource_id: string }>().then((r) => r.results);
  return { ...a, call, audits };
}
const erpObject = (profile: string) => env.COORDINATOR.get(env.COORDINATOR.idFromName("erp:" + profile));

describe("quem pode", () => {
  it("fiscal, administrador e consulta veem; consulta não monta; vendas, sem papel e bot sem concessão não", { timeout: 60_000 }, async () => {
    const { profile, call } = await area();
    const report = `/relatorio?de=${DAY}&ate=${DAY}`;
    for (const who of [await member("operator", profile, ["erp:fiscal"]), await member("admin", profile), await member("operator", profile, ["erp:consulta"])])
      expect((await call(who, "GET", report)).status).toBe(200);
    const consulta = await member("operator", profile, ["erp:consulta"]);
    expect(await call(consulta, "POST", "/pacotes", { de: DAY, ate: DAY }).catch((e) => e)).toMatchObject({ status: 403, code: "erp_fiscal_role_required" });
    expect(await call(consulta, "PUT", "/contador", { nome: "X" }).catch((e) => e)).toMatchObject({ status: 403, code: "erp_fiscal_role_required" });
    const vendas = await member("operator", profile, ["erp:vendas"]);
    expect(await call(vendas, "GET", report).catch((e) => e)).toMatchObject({ status: 403, code: "erp_fiscal_role_required" });
    expect(await call(actor("operator", [profile]), "GET", report).catch((e) => e)).toMatchObject({ status: 403, code: "erp_role_required" });
    const fiscal = await member("operator", profile, ["erp:fiscal"]);
    const viaBot: Actor = { ...fiscal, via: { kind: "internal_bot", bot_id: "b", run_id: "r" } as any };
    expect(await call(viaBot, "POST", "/envios", { pacote: "0123456789abcdef" }).catch((e) => e)).toMatchObject({ status: 403, code: "erp_bot_grant_required" });
    expect(await call(viaBot, "GET", "/contador").catch((e) => e)).toMatchObject({ status: 403, code: "erp_bot_grant_required" });
  });

  it("parte Fiscal desligada: 409 module_disabled dizendo qual módulo ligar", async () => {
    const { profile, call } = await area();
    await setModule(profile, "erp-fiscal", false, "teste");
    const refused = await call(actor("admin", [profile]), "GET", `/relatorio?de=${DAY}&ate=${DAY}`).catch((e) => e);
    expect(refused).toMatchObject({ status: 409, code: "module_disabled" });
    expect(refused.message).toMatch(/Fiscal/);
  });
});

describe("relatórios", () => {
  it("emitidas pelo cofre simulado, recebidas do ERP, CSV para planilha; período inválido não chega ao cofre", { timeout: 60_000 }, async () => {
    const { profile, call, vault } = await area({ vault: true });
    const fiscal = await member("operator", profile, ["erp:fiscal"]);
    // O cofre simulado data a nota pelo relógio dele (16/11/2026, como em tests/erp/fiscal-cofre).
    const from = "2026-11-16", to = "2026-11-16";
    const r = await (await call(fiscal, "GET", `/relatorio?ambiente=homologacao&de=${from}&ate=${to}`)).json<any>();
    expect(r).toMatchObject({ vault: true, environment: "homologacao", period: { from, to } });
    expect(r.issued.authorized.count).toBe(1);
    expect(r.issued.by_cfop).toEqual([{ key: "5102", label: "5102", count: 1, amount: r.issued.authorized.amount }]);
    expect(r.notices.some((n: string) => /não calculam guia/.test(n))).toBe(true);
    const csv = await call(fiscal, "GET", `/relatorio?ambiente=homologacao&de=${from}&ate=${to}&formato=csv`);
    expect(csv.headers.get("Content-Type")).toMatch(/text\/csv/);
    const bytes = new Uint8Array(await csv.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 com BOM: a planilha abre os acentos
    expect(new TextDecoder().decode(bytes)).toMatch(/^Relatórios fiscais para o contador;16\/11\/2026 a 16\/11\/2026\r\n/);
    const before = vault.calls.length;
    expect(await call(fiscal, "GET", `/relatorio?de=${DAY}&ate=2020-01-01`).catch((e) => e)).toMatchObject({ status: 400, code: "invalid_request" });
    expect(vault.calls.length).toBe(before);
  });

  it("sem emissor configurado: o relatório diz o que faltou e mostra o que o ERP tem", async () => {
    const { profile, call } = await area();
    const r = await (await call(await member("admin", profile), "GET", `/relatorio?de=${DAY}&ate=${DAY}`)).json<any>();
    expect(r.vault).toBe(false);
    expect(r.notices[0]).toMatch(/emissor de notas configurado/);
  });
});

describe("pacote, envio e link", () => {
  it("monta no alarme, o mesmo período não monta duas vezes, baixa o ZIP; envio sem linha fica registrado; o link baixa e vence", { timeout: 90_000 }, async () => {
    const { profile, call, audits } = await area();
    const fiscal = await member("operator", profile, ["erp:fiscal"]);
    const first = await call(fiscal, "POST", "/pacotes", { de: DAY, ate: DAY });
    expect(first.status).toBe(201);
    const { pacote } = await first.json<any>();
    expect(pacote).toMatchObject({ from: DAY, to: DAY, environment: "producao" });
    const again = await call(fiscal, "POST", "/pacotes", { de: DAY, ate: DAY });
    expect(again.status).toBe(200);
    expect((await again.json<any>()).reaproveitado).toBe(true);
    for (let i = 0; i < 10; i++) {
      const listed = await (await call(fiscal, "GET", "/pacotes")).json<any>();
      if (listed.pacotes[0].state !== "running") break;
      await runDurableObjectAlarm(erpObject(profile));
    }
    const view = await (await call(fiscal, "GET", `/pacotes/${pacote.id}`)).json<any>();
    expect(view.pacote.state).toBe("done");
    const zip = readStoredZip(new Uint8Array(await (await call(fiscal, "GET", `/pacotes/${pacote.id}/arquivo`)).arrayBuffer()));
    expect(zip.map((e) => e.name)).toEqual([`indice-notas_${DAY}_a_${DAY}.csv`]);
    expect(new TextDecoder().decode(zip[0].data)).toMatch(/Aviso;As notas emitidas ficaram de fora/);
    // Cadastro do contador: validação e gravação.
    expect(await call(fiscal, "PUT", "/contador", { whatsapp: "123" }).catch((e) => e)).toMatchObject({ status: 400, code: "invalid_request" });
    expect(await call(fiscal, "PUT", "/contador", { automatico: true, canal: "email" }).catch((e) => e)).toMatchObject({ status: 400 });
    const saved = await (await call(fiscal, "PUT", "/contador", { nome: "Ana Contadora", whatsapp: "(11) 98765-4321", dia: 5 })).json<any>();
    expect(saved.contador).toMatchObject({ nome: "Ana Contadora", whatsapp: "5511987654321", automatico: false, dia: 5 });
    // Sem endereço público da instalação, não há link: recusa antes de registrar.
    expect(await call(fiscal, "POST", "/envios", { pacote: pacote.id }).catch((e) => e)).toMatchObject({ status: 409, code: "public_origin_missing" });
    await exec(env, "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://contador.example.test',?)", Date.now());
    // WhatsApp: o contador nunca escreveu e a área não tem o modelo de aviso ligado; a regra da
    // janela de 24 horas recusa com o motivo, e o envio fica registrado como falhou.
    const refused = await call(fiscal, "POST", "/envios", { pacote: pacote.id }).catch((e) => e);
    expect(refused).toMatchObject({ status: 409, code: "erp_contador_whatsapp_blocked" });
    expect(refused.message).toMatch(/contador nunca escreveu/i);
    expect(refused.message).toMatch(/envie por e-mail/);
    const sends = await (await call(fiscal, "GET", "/envios")).json<any>();
    expect(sends.envios[0]).toMatchObject({ situacao: "falhou", canal: "whatsapp", contador: "Ana Contadora" });
    expect(sends.envios[0].destino).not.toContain("98765");
    // E-mail sem configuração na instalação: recusa antes de criar link.
    await call(fiscal, "PUT", "/contador", { email: "ana@escritorio.test" });
    expect(await call(fiscal, "POST", "/envios", { pacote: pacote.id, canal: "email" }).catch((e) => e)).toMatchObject({ status: 409, code: "email_unavailable" });
    // O link: código só na mensagem; aqui o registro é gravado à mão como enviado.
    const token = "A".repeat(43), now = Date.now();
    await exec(env, `INSERT INTO erp_contador_sends(id,profile_id,package_id,environment,period_from,period_to,channel,destination,token_hash,expires,status,auto,actor,actor_name,created,updated)
      VALUES(?,?,?,?,?,?,?,?,?,?,'enviado',0,?,?,?,?)`, uid(), profile, pacote.id, "producao", DAY, DAY, "whatsapp", "+5511…4321", await sha(token), now + 60_000, fiscal.id, "Pessoa", now, now);
    const download = await contadorPublicDownload(env, token);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Type")).toBe("application/zip");
    expect(readStoredZip(new Uint8Array(await download.arrayBuffer())).length).toBe(1);
    expect((await one<any>(env, "SELECT downloads FROM erp_contador_sends WHERE token_hash=?", await sha(token))).downloads).toBe(1);
    expect((await contadorPublicDownload(env, "B".repeat(43))).status).toBe(404);
    expect((await contadorPublicDownload(env, "curto")).status).toBe(404);
    await exec(env, "UPDATE erp_contador_sends SET expires=? WHERE token_hash=?", now - 1, await sha(token));
    expect((await contadorPublicDownload(env, token)).status).toBe(410);
    // Fiscal desligado: o link não baixa.
    await exec(env, "UPDATE erp_contador_sends SET expires=? WHERE token_hash=?", now + 60_000, await sha(token));
    await setModule(profile, "erp-fiscal", false, "teste");
    expect((await contadorPublicDownload(env, token)).status).toBe(404);
    const ops = (await audits()).map((a) => a.operation);
    expect(ops).toEqual(expect.arrayContaining(["erp_contador.package", "erp_contador.download", "erp_contador.settings", "erp_contador.send_failed"]));
  });

  it("envio automático: desligado por padrão; no dia escolhido monta o mês anterior, envia uma vez e registra", { timeout: 90_000 }, async () => {
    const { profile, call } = await area();
    const fiscal = await member("operator", profile, ["erp:fiscal"]);
    // O objeto do ERP usa o relógio de verdade: o mês anterior ao de hoje já acabou (pacote montado depois do fim do mês).
    const today = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
    const day10 = Date.now(), day3 = Date.parse(`${today.slice(0, 7)}-03T15:00:00Z`);
    const [y, m] = today.split("-").map(Number);
    const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    const prevLast = new Date(Date.UTC(Number(prev.slice(0, 4)), Number(prev.slice(5, 7)), 0)).getUTCDate();
    expect(await runAutoSend(env, profile, day10)).toBe("off");
    const settings = await (await call(fiscal, "GET", "/contador")).json<any>();
    expect(settings.contador).toMatchObject({ automatico: false, dia: 5 });
    await exec(env, "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://contador.example.test',?)", Date.now());
    await call(fiscal, "PUT", "/contador", { nome: "Ana", whatsapp: "11987654321", automatico: true, dia: 5 });
    expect(await runAutoSend(env, profile, day3)).toBe("skipped"); // antes do dia escolhido
    await call(fiscal, "PUT", "/contador", { dia: 1 });
    let outcome = await runAutoSend(env, profile, day10);
    for (let i = 0; i < 10 && outcome === "waiting"; i++) {
      await runDurableObjectAlarm(erpObject(profile));
      outcome = await runAutoSend(env, profile, day10);
    }
    // A linha da área não leva a mensagem (o contador nunca escreveu, sem modelo de aviso): falhou, registrado.
    expect(outcome).toBe("failed");
    const sends = await (await call(fiscal, "GET", "/envios")).json<any>();
    expect(sends.envios[0]).toMatchObject({ automatico: true, situacao: "falhou", de: `${prev}-01`, ate: `${prev}-${prevLast}`, por: "Envio automático" });
    expect(sends.envios[0].erro).toMatch(/contador nunca escreveu/i);
    // O mesmo mês não é tratado de novo.
    expect(await runAutoSend(env, profile, day10 + 60_000)).toBe("skipped");
    expect((await one<any>(env, "SELECT auto_last_month FROM erp_contador_settings WHERE profile_id=?", profile)).auto_last_month).toBe(prev);
  });
});
