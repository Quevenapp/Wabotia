import { SELF, env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { now, uid } from "../src/types";
import { perform } from "../src/service";
import {
  api,
  application,
  bearer,
  fixture,
  type Fixture,
} from "./service-center-fixture";

// Achado no iPad: o socket da fila de uma credencial revogada continuava
// recebendo chamadas até o 401 da próxima leitura. Agora fecha na hora (4401).
async function open(path: string, headers: Record<string, string>) {
  const response = await SELF.fetch("https://test" + path, {
    headers: { Upgrade: "websocket", ...headers },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  let closed: { code: number; reason: string } | null = null;
  const done = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (event) => {
      closed = { code: event.code, reason: event.reason };
      resolve(closed);
    }),
  );
  return { ws, done, state: () => closed };
}
const queueWs = (f: Fixture, token: string) =>
  open(`/api/v1/profiles/${f.profile}/queue/ws`, {
    Authorization: `Bearer ${token}`,
  });
/** Dá tempo ao evento de fechamento chegar (ou não). */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("WebSocket da fila fecha quando a credencial é revogada", () => {
  it("chave revogada pelo administrador: fecha só os sockets dela", async () => {
    const f = await fixture();
    const device = await application(f, ["queue:read"]);
    const other = await application(f, ["queue:read"]);
    const a = await queueWs(f, device.token);
    const b = await queueWs(f, other.token);
    const key = await one(
      env,
      "SELECT id FROM api_keys WHERE app_id=?",
      device.id,
    );
    const revoked = await api(
      await bearer(f.admin),
      `/keys/${key.id}`,
      "DELETE",
      {},
    );
    expect(revoked.status).toBe(200);
    expect(await a.done).toEqual({
      code: 4401,
      reason: "Credencial revogada",
    });
    await settle();
    expect(b.state()).toBeNull();
    b.ws.close();
  });

  it("aparelho que desfaz o pareamento e pareamento revogado pelo painel", async () => {
    const f = await fixture();
    const pair = async () => {
      const app = await application(f, ["queue:read"]);
      const key = await one(
        env,
        "SELECT id FROM api_keys WHERE app_id=?",
        app.id,
      );
      const id = uid();
      await exec(
        env,
        "INSERT INTO pairing_requests(id,client,instance_name,device_hash,user_hash,status,expires,profile_id,app_id,key_id,created,updated) VALUES(?,'senhapp','Totem',?,?,'consumed',?,?,?,?,?,?)",
        id,
        uid(),
        uid(),
        now() + 600000,
        f.profile,
        app.id,
        key.id,
        now(),
        now(),
      );
      return { ...app, pairing: id };
    };
    const self = await pair();
    const ws = await queueWs(f, self.token);
    const out = await SELF.fetch("https://test/api/v1/pairings/disconnect", {
      method: "POST",
      headers: { Authorization: `Bearer ${self.token}` },
    });
    expect(out.status).toBe(200);
    expect((await ws.done).code).toBe(4401);

    const panel = await pair();
    const ws2 = await queueWs(f, panel.token);
    const revoke = await api(
      await bearer(f.admin),
      `/pairings/${panel.pairing}`,
      "DELETE",
    );
    expect(revoke.status).toBe(200);
    expect((await ws2.done).code).toBe(4401);
  });

  it("permissão retirada da aplicação fecha os sockets dela (revisão B4)", async () => {
    const f = await fixture();
    const app = await application(f, ["queue:read", "conversations:read"]);
    const ws = await queueWs(f, app.token);
    const changed = await api(
      await bearer(f.admin),
      `/applications/${app.id}`,
      "PATCH",
      { scopes: ["conversations:read"] },
    );
    expect(changed.status).toBe(200);
    expect((await ws.done).code).toBe(4401);
  });

  it("credencial que vence com o socket aberto: o alarme fecha (revisão B4)", async () => {
    const f = await fixture();
    const app = await application(f, ["queue:read"]);
    await exec(
      env,
      "UPDATE api_keys SET expires=? WHERE app_id=?",
      now() + 1500,
      app.id,
    );
    const ws = await queueWs(f, app.token);
    const keep = await application(f, ["queue:read"]);
    const other = await queueWs(f, keep.token);
    await new Promise((r) => setTimeout(r, 1700));
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
    await stub.fetch("https://coordinator/wake", {
      method: "POST",
      body: JSON.stringify({ profile: f.profile }),
    });
    await runDurableObjectAlarm(stub);
    expect((await ws.done).code).toBe(4401);
    await settle();
    expect(other.state()).toBeNull();
    other.ws.close();
  });

  it("painel de TV revogado e pessoa que sai (só a sessão dela)", async () => {
    const f = await fixture();
    const display = await perform(
      env,
      f.admin,
      f.profile,
      "queue.display.create",
      { name: "TV da recepção" },
      uid(),
    );
    const tv = await open("/api/public/queue-display/ws", {
      Authorization: `Display ${display.token}`,
    });
    const admin = await bearer(f.admin);
    const gone = await api(
      admin,
      `/profiles/${f.profile}/queue/displays/${display.id}`,
      "DELETE",
      {},
    );
    expect(gone.status).toBe(200);
    expect((await tv.done).code).toBe(4401);

    // Dois aparelhos da mesma pessoa: sair em um não derruba o outro.
    const phone = await bearer(f.member);
    const tablet = await bearer(f.member);
    const p = await queueWs(f, phone);
    const t = await queueWs(f, tablet);
    const logout = await SELF.fetch("https://test/api/v1/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${phone}` },
    });
    expect(logout.status).toBe(200);
    expect((await p.done).code).toBe(4401);
    await settle();
    expect(t.state()).toBeNull();

    // Pessoa alterada pelo administrador (sessões apagadas): fecha todas.
    const changed = await api(admin, `/users/${f.member.id}`, "PATCH", {
      name: "Outro nome",
    });
    expect(changed.status).toBe(200);
    expect((await t.done).code).toBe(4401);
  });
});
