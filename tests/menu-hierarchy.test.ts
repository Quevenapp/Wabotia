import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { type Actor, defaults, json, now, uid } from "../src/types";
import { conversation, inbound, perform, settings } from "../src/service";
import {
  availableMenus,
  listMenus,
  selectedMenu,
  sendMenu,
} from "../src/line-service";
import { processInbox } from "../src/engine";

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const profile = uid(),
    line = uid(),
    second = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,'Menus',?,1,?)",
    profile,
    JSON.stringify(defaults),
    now(),
  );
  for (const id of [line, second])
    await exec(
      env,
      "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'Linha','zernio','direct','active',?,?)",
      id,
      profile,
      JSON.stringify({ service: { mode: "inherit", menu_mode: "manual" } }),
      now(),
    );
  const actor: Actor = {
    id: uid(),
    name: "Admin",
    kind: "user",
    role: "admin",
    profiles: [profile],
    scopes: [],
    bots: [],
    rate: 100,
    runLimit: 5,
  };
  return { profile, line, second, actor };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const save = (f: Fixture, menus: any[]) =>
  perform(env, f.actor, f.profile, "settings", { menus }, uid());
async function receive(f: Fixture, text: string, content?: any) {
  const r = await inbound(
    env,
    f.profile,
    { external_id: "5511999991234", message_id: uid(), text, content },
    "channel:" + f.line,
    f.line,
  );
  await processInbox(env, f.profile);
  return conversation(env, r.conversation_id, f.profile);
}
async function latest(id: string) {
  return json(
    (
      await one(
        env,
        "SELECT payload FROM outbox WHERE conversation_id=? ORDER BY created DESC,rowid DESC LIMIT 1",
        id,
      )
    ).payload,
  );
}

it("permite cadastrar um submenu vazio sem oferecê-lo ao cliente até ter uma folha", async () => {
  const f = await fixture(),
    root = { id: "support", label: "Suporte", type: "submenu" };
  await save(f, [root]);
  expect((await listMenus(env, f.actor, f.profile)).data).toHaveLength(1);
  expect(await availableMenus(env, f.profile, f.line)).toEqual([]);
  await save(f, [
    root,
    { id: "area", label: "Aplicativo", type: "submenu", parent_id: "support" },
    {
      id: "help",
      label: "Ajuda",
      type: "content",
      content: "Texto de ajuda",
      parent_id: "area",
    },
  ]);
  expect(
    (await availableMenus(env, f.profile, f.line)).map((m) => m.id),
  ).toEqual(["support"]);
  expect(
    (await availableMenus(env, f.profile, f.line, "support")).map((m) => m.id),
  ).toEqual(["area"]);
  expect(
    (await availableMenus(env, f.profile, f.line, "area")).map((m) => m.id),
  ).toEqual(["help"]);
});

it.each([
  "disabled",
  "ancestor-disabled",
  "manual",
  "other-line",
  "disjoint",
  "human-disabled",
  "bot-disabled",
])(
  "oculta ramo sem folha executável por %s e mantém a árvore completa no editor",
  async (reason) => {
    const f = await fixture();
    const root: any = { id: "root", label: "Raiz", type: "submenu" },
      leaf: any = {
        id: "leaf",
        label: "Atendente",
        type: "human",
        parent_id: "root",
      };
    if (reason === "disabled") leaf.enabled = false;
    if (reason === "ancestor-disabled") root.enabled = false;
    if (reason === "manual") leaf.trigger = "manual";
    if (reason === "other-line") leaf.line_ids = [f.second];
    if (reason === "disjoint") {
      root.line_ids = [f.line];
      leaf.line_ids = [f.second];
    }
    if (reason === "human-disabled")
      await exec(
        env,
        "UPDATE connections SET config=json_set(config,'$.number_policy.human',json('false')) WHERE id=?",
        f.line,
      );
    if (reason === "bot-disabled") {
      const bot = uid();
      await exec(
        env,
        "INSERT INTO bots(id,profile_id,connection_id,remote_profile,name,enabled) VALUES(?,?,?,'test','Bot',0)",
        bot,
        f.profile,
        f.line,
      );
      leaf.type = "bot";
      leaf.bot_id = bot;
    }
    await save(f, [root, leaf]);
    expect((await listMenus(env, f.actor, f.profile)).data).toHaveLength(2);
    expect(await availableMenus(env, f.profile, f.line)).toEqual([]);
    if (reason !== "manual")
      expect((await listMenus(env, f.actor, f.profile, f.line)).data).toEqual(
        [],
      );
    if (reason === "manual")
      expect(
        (await availableMenus(env, f.profile, f.line, null, true)).map(
          (m) => m.id,
        ),
      ).toEqual(["root"]);
    if (reason === "disjoint")
      expect(await availableMenus(env, f.profile, f.second)).toEqual([]);
  },
);

it("navega três níveis, VOLTAR sobe ao pai e MENU vai à raiz sem perder o responsável", async () => {
  const f = await fixture(),
    fetch = vi.spyOn(globalThis, "fetch");
  await save(f, [
    {
      id: "a",
      label: "Serviços",
      type: "submenu",
      trigger: "manual",
      line_ids: [f.line],
    },
    { id: "b", label: "Aplicativos", type: "submenu", parent_id: "a" },
    { id: "c", label: "Pedidos", type: "submenu", parent_id: "b" },
    {
      id: "leaf",
      label: "Consultar",
      type: "content",
      content: "Consulta autorizada",
      parent_id: "c",
    },
  ]);
  const incoming = await inbound(
    env,
    f.profile,
    {
      external_id: "5511999991234",
      message_id: uid(),
      text: "Preciso de ajuda",
    },
    "channel:" + f.line,
    f.line,
  );
  await exec(
    env,
    "UPDATE inbox SET status='done' WHERE conversation_id=?",
    incoming.conversation_id,
  );
  await perform(
    env,
    f.actor,
    f.profile,
    "conversation.action",
    { id: incoming.conversation_id, action: "claim" },
    uid(),
  );
  await perform(
    env,
    f.actor,
    f.profile,
    "conversation.action",
    { id: incoming.conversation_id, action: "menu" },
    uid(),
  );
  for (const parent of ["a", "b", "c"]) {
    const c = await receive(f, "1");
    expect(c).toMatchObject({
      menu_parent: parent,
      menu_manual: 1,
      state: "human",
      owner: f.actor.id,
    });
  }
  const deepest = await conversation(env, incoming.conversation_id, f.profile),
    oldToken = deepest.menu_token;
  expect((await latest(deepest.id)).text).toContain("VOLTAR");
  expect(await receive(f, "VOLTAR")).toMatchObject({
    menu_parent: "b",
    menu_manual: 1,
    state: "human",
    owner: f.actor.id,
  });
  expect(await receive(f, "MENU")).toMatchObject({
    menu_parent: null,
    menu_manual: 1,
    state: "human",
    owner: f.actor.id,
  });
  await receive(f, "Consultar", {
    interactive_reply_id: `wmenu:${oldToken}:leaf`,
  });
  expect((await latest(deepest.id)).text).toContain("não está mais disponível");
  expect(
    (await conversation(env, deepest.id, f.profile)).menu_parent,
  ).toBeNull();
  expect(
    (
      await all(
        env,
        "SELECT payload FROM outbox WHERE conversation_id=?",
        deepest.id,
      )
    ).some((row) => json(row.payload).text === "Consulta autorizada"),
  ).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  await save(f, []);
  expect(await receive(f, "MENU")).toMatchObject({
    menu_parent: null,
    menu_active: 0,
    state: "human",
    owner: f.actor.id,
  });
  expect((await latest(deepest.id)).text).toContain("Nenhuma opção de menu");
});

it("serviço desabilitado não oferece nem envia menus, inclusive por comando do cliente", async () => {
  const f = await fixture();
  await save(f, [
    { id: "root", label: "Suporte", type: "submenu" },
    {
      id: "leaf",
      label: "Ajuda",
      type: "content",
      parent_id: "root",
      content: "Ajuda",
    },
  ]);
  await exec(
    env,
    "UPDATE connections SET config=json_set(config,'$.number_policy.service',json('false'),'$.service.menu_mode','automatic') WHERE id=?",
    f.line,
  );
  expect(await availableMenus(env, f.profile, f.line)).toEqual([]);
  const c = await receive(f, "MENU");
  await expect(sendMenu(env, f.actor, c, null, uid())).rejects.toMatchObject({
    status: 403,
    code: "number_policy_denied",
  });
  expect(
    await all(env, "SELECT id FROM outbox WHERE conversation_id=?", c.id),
  ).toEqual([]);
});

it("MENU não encaminha para uma pessoa quando a única pasta automática está vazia", async () => {
  const f = await fixture();
  await save(f, [{ id: "root", label: "Suporte", type: "submenu" }]);
  await exec(
    env,
    "UPDATE connections SET config=json_set(config,'$.service.menu_mode','automatic') WHERE id=?",
    f.line,
  );
  const c = await receive(f, "MENU");
  expect(c).toMatchObject({
    state: "ai",
    owner: null,
    menu_active: 0,
    menu_parent: null,
  });
  expect((await latest(c.id)).text).toContain("Nenhuma opção de menu");
  expect((await latest(c.id)).text).not.toContain("Suporte");
});

it.each([0, false, [], {}])(
  "recusa parent_id malformado %j sem alterar a árvore",
  async (parent_id) => {
    const f = await fixture();
    await save(f, [
      { id: "keep", label: "Manter", type: "content", content: "Texto" },
    ]);
    const before = await settings(env, f.profile);
    await expect(
      save(f, [{ id: "bad", label: "Inválido", type: "submenu", parent_id }]),
    ).rejects.toMatchObject({ status: 400 });
    expect(await settings(env, f.profile)).toEqual(before);
  },
);

it("normaliza raiz e rótulos, preserva vínculos e rejeita órfãos, ciclos e pais terminais", async () => {
  const f = await fixture();
  await save(f, [
    { id: "root", label: "  Raiz  ", type: "submenu", parent_id: "" },
    {
      id: "leaf",
      label: "  Ajuda  ",
      type: "content",
      content: "Ajuda",
      parent_id: "root",
    },
  ]);
  const before = await settings(env, f.profile);
  expect(before.menus).toMatchObject([
    { id: "root", label: "Raiz", parent_id: null },
    { id: "leaf", label: "Ajuda", parent_id: "root" },
  ]);
  for (const menus of [
    [{ id: "a", label: "A", type: "submenu", parent_id: "missing" }],
    [
      { id: "a", label: "A", type: "submenu", parent_id: "b" },
      { id: "b", label: "B", type: "submenu", parent_id: "a" },
    ],
    [
      { id: "a", label: "A", type: "content", content: "A" },
      { id: "b", label: "B", type: "human", parent_id: "a" },
    ],
    [{ id: "a", label: "A", type: "submenu", enabled: "false" }],
  ]) {
    await expect(save(f, menus)).rejects.toMatchObject({ status: 400 });
    expect(await settings(env, f.profile)).toEqual(before);
  }
});

it("uma seleção textual não ignora expiração ou itens que não estavam no menu enviado", () => {
  const current: any = {
    menu_active: 1,
    session: "session",
    menu_token: "session.token",
    menu_items: '["old"]',
    menu_expires_at: now() + 1000,
  };
  const items = [
    { id: "old", label: "Antes" },
    { id: "new", label: "Nova opção" },
  ];
  expect(selectedMenu(current, items, "Nova opção")).toBeNull();
  expect(
    selectedMenu({ ...current, menu_expires_at: now() - 1 }, items, "Antes"),
  ).toBeNull();
  expect(
    selectedMenu({ ...current, menu_active: 0 }, items, "Antes"),
  ).toBeNull();
});
