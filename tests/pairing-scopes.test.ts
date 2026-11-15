import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { authenticate } from "../src/security";
import { type Actor, now, uid } from "../src/types";
import {
  pairingApprove,
  pairingLookup,
  pairingStart,
  pairingToken,
} from "../src/pairing";

const admin: Actor = {
  id: "pair-scope-admin",
  name: "Admin",
  kind: "user",
  role: "admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 300,
  runLimit: 3,
};
async function start(scopes?: unknown) {
  const profile = uid(),
    ip = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,created) VALUES(?,?,?)",
    profile,
    "Pareamento",
    now(),
  );
  const session = await pairingStart(
    env,
    {
      client: "senhapp",
      instance_name: "Totem da recepção",
      ...(scopes === undefined ? {} : { scopes }),
    },
    "https://wabotia.test",
    ip,
  );
  const request = await pairingLookup(env, admin, session.user_code);
  return { profile, ip, session, request };
}

describe("pareamento: permissões pedidas pelo aparelho", () => {
  it("totem pede queue:read e queue:issue: só isso é oferecido e concedido", async () => {
    const f = await start(["queue:issue", "queue:read"]);
    expect(f.session.scopes).toEqual(["queue:read", "queue:issue"]);
    expect(f.request.requested_scopes).toEqual(["queue:read", "queue:issue"]);
    // O painel pré-marca e lista só o que o aparelho pediu.
    expect(f.request.allowed_scopes).toEqual(["queue:read", "queue:issue"]);
    await expect(
      pairingApprove(env, admin, f.request.id, {
        profile_id: f.profile,
        scopes: ["queue:read", "queue:issue", "queue:operate"],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await pairingApprove(env, admin, f.request.id, {
      profile_id: f.profile,
      scopes: ["queue:read", "queue:issue"],
    });
    await exec(
      env,
      "UPDATE pairing_requests SET next_poll_at=0 WHERE id=?",
      f.request.id,
    );
    const token = await pairingToken(
      env,
      { client: "senhapp", device_code: f.session.device_code },
      f.ip,
    );
    expect(token.scopes).toEqual(["queue:read", "queue:issue"]);
    const actor = await authenticate(
      env,
      new Request("https://wabotia.test/api/v1/profiles", {
        headers: { Authorization: `Bearer ${token.access_token}` },
      }),
    );
    expect(actor.scopes).not.toContain("queue:operate");
  });

  it("pedido antigo, sem scopes, continua como antes", async () => {
    const f = await start();
    expect(f.session).not.toHaveProperty("scopes");
    expect(f.request.requested_scopes).toBeNull();
    expect(f.request.allowed_scopes).toEqual([
      "queue:read",
      "queue:issue",
      "queue:operate",
      "events:read",
    ]);
    await pairingApprove(env, admin, f.request.id, {
      profile_id: f.profile,
      scopes: ["queue:read", "queue:operate"],
    });
    expect(
      (
        await one(
          env,
          "SELECT status FROM pairing_requests WHERE id=?",
          f.request.id,
        )
      ).status,
    ).toBe("approved");
  });

  it("recusa permissões fora do cliente ou lista vazia", async () => {
    await expect(start(["routing:send"])).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(start([])).rejects.toMatchObject({ code: "invalid_request" });
    await expect(start("queue:read")).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});
