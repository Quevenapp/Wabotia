import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { perform } from "../src/service";
import { now, uid } from "../src/types";
import { motorWorkType } from "./os-motor-fixture";
import { integrationFixture, integrationHarness } from "./os-integration-fixture";

async function setup() {
  const h = integrationHarness(env, {
    context: createExecutionContext,
    drain: waitOnExecutionContext,
    inside: (stub, fn) => (runInDurableObject as any)(stub, fn),
  });
  const f = await integrationFixture(h);
  await perform(env, f.actor, f.profile, "module.set", { id: "os", enabled: true }, uid());
  const catalog = await f.call("/service-orders/types");
  await f.call("/settings", "PUT", {
    os_work_types: [motorWorkType()], settings_revision: catalog.settings_revision,
  });
  const order = await f.call("/service-orders", "POST", {
    type_id: motorWorkType().id, phone: "5511960010203", item: "Projeto",
    problem: "Conferir documento", notify: false,
  });
  const document = await f.call(`/service-orders/${order.id}/documents`, "POST", {
    name: "Documento.txt", mime_type: "text/plain", expected_bytes: 3,
    client_visible: true, sensitive: false,
  });
  const path = `/service-orders/${order.id}/documents/${document.id}`;
  const key = uid();
  const upload = (body = "abc") => h.fetch(new Request(`https://test${f.root}${path}/content`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${f.token}`, "Content-Type": "text/plain",
      "Idempotency-Key": key, "Upload-Version": "1",
    },
    body,
  }));
  const row = () => one(env,
    "SELECT * FROM os_documents WHERE profile_id=? AND order_id=? AND id=?",
    f.profile, order.id, document.id,
  );
  const expireLease = () => exec(env,
    "UPDATE os_documents SET upload_lease_until=? WHERE profile_id=? AND order_id=? AND id=?",
    now() - 60000, f.profile, order.id, document.id,
  );
  return { h, f, order, document, path, key, upload, row, expireLease };
}

describe("documentos: recuperação pelo HTTP e Coordinator reais", () => {
  it("renova após recibo begin antigo, preserva tentativa e exclusividade", async () => {
    const s = await setup();
    // Falha de tamanho deixa begin concluído, sem objeto e sem registro técnico.
    expect((await s.upload("inválido")).status).toBe(409);
    const attempt = (await s.row())!.upload_attempt;
    for (let retry = 0; retry < 2; retry++) {
      await s.expireLease();
      expect((await s.upload("inválido")).status).toBe(409);
      const row = (await s.row())!;
      expect(row.upload_attempt).toBe(attempt);
      expect(row.upload_lease_until).toBeGreaterThan(now());
      expect(await env.MEDIA.head(row.r2_key)).toBeNull();
    }
    const sent = await s.upload();
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ upload_attempt: attempt, byte_length: 3 });
  });

  it("recupera objeto após concessão vencida e recibos técnicos sem resposta", async () => {
    const s = await setup();
    const sent = await s.upload();
    expect(sent.status).toBe(200);
    const result = await sent.json();
    // Fronteira durável de PUT gravado, ainda sem registro técnico no D1.
    await exec(env,
      "UPDATE os_documents SET byte_length=NULL,sha256=NULL WHERE profile_id=? AND order_id=? AND id=?",
      s.f.profile, s.order.id, s.document.id,
    );
    await s.expireLease();
    await exec(env,
      "UPDATE receipts SET response=NULL WHERE key=? AND scope IN (?,?)",
      s.key, `${s.f.actor.id}:${s.f.profile}:os.document.upload.begin`,
      `${s.f.actor.id}:${s.f.profile}:os.document.upload.record`,
    );
    const retry = await s.upload("não consumir nem sobrescrever");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(result);
    expect(await (await env.MEDIA.get((await s.row())!.r2_key))!.text()).toBe("abc");
  });

  it.each([false, true])("confirma e retoma publicação interrompida sem duplicar (privado=%s)", async (privateRoute) => {
    const s = await setup();
    // O fluxo privado usa a mesma recuperação, com autorização humana explícita.
    if (privateRoute) {
      const { grantSensitive } = await import("./os-integration-fixture");
      await grantSensitive(s.h, s.f);
      const reserved = await s.f.call(`/service-orders/${s.order.id}/private-documents`, "POST", {
        name: "Restrito.txt", mime_type: "text/plain", expected_bytes: 3,
        client_visible: false, sensitive: true,
      });
      s.document = reserved;
      s.path = `/service-orders/${s.order.id}/private-documents/${reserved.id}`;
    }
    const upload = await s.h.fetch(new Request(`https://test${s.f.root}${s.path}/content`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${s.f.token}`, "Idempotency-Key": uid(), "Upload-Version": "1" },
      body: "abc",
    }));
    expect(upload.status).toBe(200);
    const transport = await upload.json<any>();
    const key = uid(), body = { version: 1, upload_attempt: transport.upload_attempt };
    const trigger = `document_publish_${s.document.id}`;
    // Interrompe exatamente depois do commitChild real e antes de publicar/fechar recibo.
    await exec(env, `CREATE TRIGGER "${trigger}" BEFORE INSERT ON events
      WHEN NEW.profile_id='${s.f.profile}' AND NEW.kind='os.document_ready'
      BEGIN SELECT RAISE(FAIL, 'document_publication_interrupted'); END`);
    try {
      const interrupted = await s.h.fetch(s.f.request(s.path + "/complete", "POST", body, key));
      expect(interrupted.status).toBe(500);
    } finally {
      await exec(env, `DROP TRIGGER "${trigger}"`);
    }
    expect(await one(env,
      "SELECT state,version FROM os_documents WHERE profile_id=? AND order_id=? AND id=?",
      s.f.profile, s.order.id, s.document.id,
    )).toEqual({ state: "ready", version: 2 });
    const scope = `${s.f.actor.id}:${s.f.profile}:os.${privateRoute ? "private." : ""}document.complete`;
    expect(await one(env, "SELECT response FROM receipts WHERE scope=? AND key=?", scope, key))
      .toEqual({ response: null });
    expect(await all(env,
      "SELECT id FROM events WHERE profile_id=? AND resource_id=? AND kind='os.document_ready'",
      s.f.profile, s.document.id,
    )).toHaveLength(0);
    const recovered = await s.f.call(s.path + "/complete", "POST", body, key);
    expect(recovered).toEqual({ id: s.document.id, order_id: s.order.id, version: 2 });
    expect(await s.f.call(s.path + "/complete", "POST", body, key)).toEqual(recovered);
    expect(await all(env,
      "SELECT id FROM os_history WHERE profile_id=? AND order_id=? AND entity_id=? AND kind='os.document_ready'",
      s.f.profile, s.order.id, s.document.id,
    )).toHaveLength(1);
    expect(await all(env,
      "SELECT id FROM events WHERE profile_id=? AND resource_id=? AND kind='os.document_ready'",
      s.f.profile, s.document.id,
    )).toHaveLength(1);
  });
});
