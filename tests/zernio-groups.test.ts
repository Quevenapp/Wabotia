import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { groupCommand } from "../src/groups";
import { setSecret } from "../src/security";
import { syncGroup } from "../src/whatsapp";
import { type Actor, defaults, now, uid } from "../src/types";

afterEach(() => vi.restoreAllMocks());

async function fixture(groups = true) {
  const profile = uid(),
    id = uid();
  const actor: Actor = {
    id: uid(),
    kind: "user",
    role: "admin",
    name: "Admin",
    profiles: [],
    scopes: [],
    bots: [],
    rate: 300,
    runLimit: 10,
  };
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    profile,
    "Grupos Zernio",
    JSON.stringify(defaults),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'zernio','direct','active',?,?)",
    id,
    profile,
    "WhatsApp",
    JSON.stringify({
      account_id: "66a1f0c2a4b9d3e8f1a2b3c4",
      zernio_profile_id: "66a1f0c2a4b9d3e8f1a2b3c5",
      number: "5511999990000",
      groups_enabled: groups,
    }),
    now(),
  );
  await setSecret(env, "connection:" + id, { api_key: "test-api-key" });
  const conn = await one(env, "SELECT * FROM connections WHERE id=?", id);
  const command = (data: any) =>
    groupCommand(
      env,
      actor,
      profile,
      "group.action",
      { connection_id: id, ...data },
      uid(),
    );
  return { profile, id, actor, conn, command };
}

it("cria grupo pela Zernio e materializa conversa, convite e operação sem duplicar pedido", async () => {
  const f = await fixture();
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      expect(String(input)).toBe(
        "https://zernio.com/api/v1/whatsapp/wa-groups",
      );
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({
        accountId: "66a1f0c2a4b9d3e8f1a2b3c4",
        subject: "Equipe",
        joinApprovalMode: "auto_approve",
      });
      return Response.json(
        {
          success: true,
          group: {
            groupId: "120363000000@g.us",
            inviteLink: "https://chat.whatsapp.com/invite-example",
          },
        },
        { status: 201 },
      );
    });
  const request = { connection_id: f.id, action: "create", subject: "Equipe" },
    key = uid();
  const coordinator = env.COORDINATOR.get(
    env.COORDINATOR.idFromName(f.profile),
  );
  const command = async () => {
    const response = await coordinator.fetch("https://coordinator/command", {
      method: "POST",
      body: JSON.stringify({
        profile: f.profile,
        actor: f.actor,
        operation: "group.action",
        data: request,
        key,
        requestId: uid(),
      }),
    });
    expect(response.status).toBe(200);
    return response.json<any>();
  };
  const result = await command();
  const repeated = await command();
  expect(repeated).toEqual(result);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.status).toBe("sent");
  const c = await one(
    env,
    "SELECT * FROM conversations WHERE id=?",
    result.result.conversation_id,
  );
  expect(c).toMatchObject({
    connection_id: f.id,
    chat_type: "group",
    external_id: "120363000000@g.us",
    title: "Equipe",
  });
  expect(
    await one(
      env,
      "SELECT * FROM whatsapp_groups WHERE conversation_id=?",
      c.id,
    ),
  ).toMatchObject({
    own_admin: 1,
    invite_link: "https://chat.whatsapp.com/invite-example",
  });
  expect(
    await one(env, "SELECT * FROM group_operations WHERE id=?", result.id),
  ).toMatchObject({ conversation_id: c.id, status: "sent" });
});

it("lista grupos paginados e normaliza participantes do provedor", async () => {
  const f = await fixture();
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("accountId")).toBe(
        "66a1f0c2a4b9d3e8f1a2b3c4",
      );
      if (url.pathname.endsWith("/wa-groups")) {
        expect(url.searchParams.get("after")).toBe("cursor+previous");
        return Response.json({
          groups: [{ id: "group-one", subject: "Clientes" }],
          paging: { cursors: { after: "cursor-next" } },
        });
      }
      return Response.json({
        success: true,
        group: {
          id: "group-one",
          subject: "Clientes atualizados",
          description: "Avisos",
          participants: [{ user: "5511999991111", admin: "admin" }],
        },
      });
    });
  const list = await f.command({ action: "sync", cursor: "cursor+previous" });
  expect(list.result).toEqual({ count: 1, cursor: "cursor-next" });
  const c = await one(
    env,
    "SELECT * FROM conversations WHERE connection_id=?",
    f.id,
  );
  await f.command({ id: c.id, action: "refresh" });
  const group = await one(
    env,
    "SELECT * FROM whatsapp_groups WHERE conversation_id=?",
    c.id,
  );
  expect(group).toMatchObject({
    subject: "Clientes atualizados",
    description: "Avisos",
  });
  expect(JSON.parse(group.participants)).toEqual([
    { id: "5511999991111", name: "", admin: true },
  ]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("atualiza dados, participantes e convite pelos métodos documentados", async () => {
  const f = await fixture();
  const c = await syncGroup(env, f.conn, {
    external_id: "group/one",
    subject: "Original",
    own_admin: true,
  });
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    return Response.json(
      url.pathname.endsWith("/invite-link")
        ? { success: true, inviteLink: "https://chat.whatsapp.com/new-invite" }
        : { success: true },
    );
  });
  await f.command({
    id: c.conversation_id,
    action: "subject",
    subject: "Novo nome",
  });
  await f.command({
    id: c.conversation_id,
    action: "participants",
    operation: "add",
    participants: ["5511999991111"],
  });
  await f.command({
    id: c.conversation_id,
    action: "participants",
    operation: "remove",
    participants: ["+5511999991111"],
  });
  const invite = await f.command({ id: c.conversation_id, action: "invite" });
  expect(requests.map((r) => r.init?.method)).toEqual([
    "POST",
    "POST",
    "DELETE",
    "POST",
  ]);
  expect(
    requests.every(
      (r) =>
        r.url.pathname.includes("group%2Fone") &&
        r.url.searchParams.has("accountId"),
    ),
  ).toBe(true);
  expect(JSON.parse(requests[1].init!.body as string)).toEqual({
    phoneNumbers: ["+5511999991111"],
  });
  expect(invite.result.invite_link).toBe(
    "https://chat.whatsapp.com/new-invite",
  );
  expect(
    await one(
      env,
      "SELECT * FROM whatsapp_groups WHERE conversation_id=?",
      c.conversation_id,
    ),
  ).toMatchObject({
    subject: "Novo nome",
    invite_link: "https://chat.whatsapp.com/new-invite",
  });
});

it("não converte sair em exclusão remota e recusa ações indisponíveis antes do envio", async () => {
  const f = await fixture();
  const c = await syncGroup(env, f.conn, {
    external_id: "group-one",
    subject: "Grupo",
  });
  const fetcher = vi.spyOn(globalThis, "fetch");
  await expect(
    f.command({ id: c.conversation_id, action: "leave" }),
  ).rejects.toMatchObject({ code: "unsupported_capability" });
  await expect(
    f.command({
      action: "join",
      invite: "https://chat.whatsapp.com/valid-invite-code",
    }),
  ).rejects.toThrow("Use QR");
  await expect(
    f.command({
      id: c.conversation_id,
      action: "participants",
      operation: "promote",
      participants: ["5511999991111"],
    }),
  ).rejects.toThrow("não altera administradores");
  await expect(
    f.command({
      id: c.conversation_id,
      action: "participants",
      operation: "add",
      participants: Array(9).fill("5511999991111"),
    }),
  ).rejects.toThrow("até 8");
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    await all(
      env,
      "SELECT id FROM group_operations WHERE connection_id=?",
      f.id,
    ),
  ).toHaveLength(0);
});

it("retém resultado incerto e impede renovar convite enquanto há operação pendente", async () => {
  const f = await fixture();
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("timeout"));
  await expect(
    f.command({ action: "create", subject: "Grupo incerto" }),
  ).rejects.toMatchObject({ code: "zernio_unknown" });
  expect(
    await one(
      env,
      "SELECT status FROM group_operations WHERE connection_id=?",
      f.id,
    ),
  ).toEqual({ status: "unknown" });
  const c = await syncGroup(env, f.conn, {
    external_id: "group-existing",
    subject: "Grupo",
  });
  await expect(
    f.command({ id: c.conversation_id, action: "invite" }),
  ).rejects.toMatchObject({ code: "group_in_progress" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("marca rejeição definitiva como falha e exige capacidade habilitada", async () => {
  const f = await fixture();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ success: false }, { status: 400 }),
  );
  await expect(
    f.command({ action: "create", subject: "Grupo" }),
  ).rejects.toMatchObject({ code: "zernio_rejected" });
  expect(
    await one(
      env,
      "SELECT status FROM group_operations WHERE connection_id=?",
      f.id,
    ),
  ).toEqual({ status: "failed" });
  const disabled = await fixture(false);
  await expect(disabled.command({ action: "sync" })).rejects.toMatchObject({
    code: "unsupported_capability",
  });
});
