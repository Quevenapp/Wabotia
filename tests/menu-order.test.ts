import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { processInbox } from "../src/engine";
import {
  availableMenus,
  listMenus,
  menuPayload,
  sendMenu,
} from "../src/line-service";
import { conversation, inbound, perform } from "../src/service";
import { type Actor, defaults, json, now, uid } from "../src/types";
import { moveMenu } from "../web/menu-tree";

afterEach(() => vi.restoreAllMocks());
const initialMenus = () => [
  { id: "support", label: "Suporte", type: "submenu", parent_id: null },
  { id: "sales", label: "Comercial", type: "submenu", parent_id: null },
  {
    id: "devices",
    label: "Equipamentos",
    type: "submenu",
    parent_id: "support",
  },
  {
    id: "printer",
    label: "Impressora",
    type: "content",
    content: "Ajuda da impressora",
    parent_id: "devices",
  },
  {
    id: "computer",
    label: "Computador",
    type: "content",
    content: "Ajuda do computador",
    parent_id: "devices",
  },
  {
    id: "quote",
    label: "Orçamento",
    type: "content",
    content: "Informações comerciais",
    parent_id: "sales",
  },
];
async function fixture() {
  const profile = uid(),
    line = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,'Ordem dos menus',?,1,?)",
    profile,
    JSON.stringify({ ...defaults, menus: initialMenus() }),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'Linha','zernio','direct','active',?,?)",
    line,
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
  return { profile, line, actor };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const read = (f: Fixture) => listMenus(env, f.actor, f.profile);
const save = (f: Fixture, menus: any[], revision: string) =>
  perform(
    env,
    f.actor,
    f.profile,
    "settings",
    { menus, menus_revision: revision },
    uid(),
  );
const ids = (items: any[]) => items.map((item) => item.id);
function reorder(items: any[], order: string[]) {
  return order.map((id) => items.find((item) => item.id === id));
}
async function open(f: Fixture, parent = "devices") {
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
  await sendMenu(
    env,
    f.actor,
    await conversation(env, incoming.conversation_id, f.profile),
    parent,
    uid(),
  );
  return conversation(env, incoming.conversation_id, f.profile);
}
async function receive(f: Fixture, text: string, replyId?: string) {
  const incoming = await inbound(
    env,
    f.profile,
    {
      external_id: "5511999991234",
      message_id: uid(),
      text,
      ...(replyId ? { content: { interactive_reply_id: replyId } } : {}),
    },
    "channel:" + f.line,
    f.line,
  );
  await processInbox(env, f.profile);
  return conversation(env, incoming.conversation_id, f.profile);
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

it("persiste a ordem plana e os vínculos existentes e apresenta cada nível na nova ordem", async () => {
  const f = await fixture(),
    before = await read(f);
  const ordered = reorder(before.data, [
    "sales",
    "quote",
    "support",
    "devices",
    "computer",
    "printer",
  ]);
  await save(f, ordered, before.revision);
  const after = await read(f);
  expect(after.data).toEqual(ordered);
  expect(after.revision).not.toBe(before.revision);
  expect(ids(await availableMenus(env, f.profile, f.line))).toEqual([
    "sales",
    "support",
  ]);
  expect(ids(await availableMenus(env, f.profile, f.line, "devices"))).toEqual([
    "computer",
    "printer",
  ]);
  expect((await listMenus(env, f.actor, f.profile, f.line)).data).toEqual(
    ordered,
  );
  const leaf = await availableMenus(env, f.profile, f.line, "devices");
  const payload: any = menuPayload(leaf, "Equipamentos", "session.token", true);
  expect(payload.text).toBe("Equipamentos\n1. Computador\n2. Impressora");
  expect(
    payload.content.interactive.action.buttons.map(
      (item: any) => item.reply.id,
    ),
  ).toEqual(["wmenu:session.token:computer", "wmenu:session.token:printer"]);
  const list: any = menuPayload(
    [...leaf, ...leaf.map((item) => ({ ...item, id: item.id + "-copy" }))],
    "Equipamentos",
    "session.token",
    true,
  );
  expect(list.content.interactive.type).toBe("list");
  expect(
    list.content.interactive.action.sections[0].rows.map(
      (item: any) => item.title,
    ),
  ).toEqual([
    "1. Computador",
    "2. Impressora",
    "3. Computador",
    "4. Impressora",
  ]);
});

it.each(["number", "button"])(
  "reordenar depois da apresentação mantém a identidade da escolha por %s",
  async (mode) => {
    const f = await fixture(),
      fetch = vi.spyOn(globalThis, "fetch"),
      shown = await open(f);
    expect(json(shown.menu_items)).toEqual(["printer", "computer"]);
    expect((await latest(shown.id)).text).toContain(
      "1. Impressora\n2. Computador",
    );
    const current = await read(f);
    await save(
      f,
      moveMenu(current.data, "computer", "printer", "before"),
      current.revision,
    );
    const unchanged = await conversation(env, shown.id, f.profile);
    expect(unchanged.menu_items).toBe(shown.menu_items);
    expect(unchanged.menu_token).toBe(shown.menu_token);
    const selected = await receive(
      f,
      mode === "number" ? "1" : "Impressora",
      mode === "button" ? `wmenu:${shown.menu_token}:printer` : undefined,
    );
    expect((await latest(shown.id)).text).toBe("Ajuda da impressora");
    expect(selected).toMatchObject({
      state: "human",
      owner: f.actor.id,
      menu_active: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("uma nova apresentação usa a nova ordem sem aceitar botões da apresentação anterior", async () => {
  const f = await fixture(),
    shown = await open(f),
    current = await read(f);
  await save(
    f,
    moveMenu(current.data, "computer", "printer", "before"),
    current.revision,
  );
  await sendMenu(
    env,
    f.actor,
    await conversation(env, shown.id, f.profile),
    "devices",
    uid(),
  );
  const refreshed = await conversation(env, shown.id, f.profile);
  expect(json(refreshed.menu_items)).toEqual(["computer", "printer"]);
  expect(refreshed.menu_token).not.toBe(shown.menu_token);
  await receive(f, "Impressora", `wmenu:${shown.menu_token}:printer`);
  expect((await latest(shown.id)).text).toContain("não está mais disponível");
  await receive(f, "1");
  expect((await latest(shown.id)).text).toBe("Ajuda do computador");
});

it("mover uma opção invalida seu botão no pai anterior e permite escolhê-la no novo pai", async () => {
  const f = await fixture(),
    fetch = vi.spyOn(globalThis, "fetch"),
    shown = await open(f),
    current = await read(f);
  const moved = moveMenu(current.data, "printer", "sales", "inside");
  await save(f, moved, current.revision);
  expect(ids(await availableMenus(env, f.profile, f.line, "devices"))).toEqual([
    "computer",
  ]);
  expect(ids(await availableMenus(env, f.profile, f.line, "sales"))).toEqual([
    "quote",
    "printer",
  ]);
  const rejected = await receive(
    f,
    "Impressora",
    `wmenu:${shown.menu_token}:printer`,
  );
  expect((await latest(shown.id)).text).toContain("não está mais disponível");
  expect(rejected).toMatchObject({
    menu_parent: "devices",
    state: "human",
    owner: f.actor.id,
  });
  expect(
    (
      await all(
        env,
        "SELECT payload FROM outbox WHERE conversation_id=?",
        shown.id,
      )
    ).some((row) => json(row.payload).text === "Ajuda da impressora"),
  ).toBe(false);
  await sendMenu(env, f.actor, rejected, "sales", uid());
  const relocated = await conversation(env, shown.id, f.profile);
  await receive(f, "Impressora", `wmenu:${relocated.menu_token}:printer`);
  expect((await latest(shown.id)).text).toBe("Ajuda da impressora");
  expect(fetch).not.toHaveBeenCalled();
});

it("mover a primeira opção não remapeia sua posição numérica para o irmão que permaneceu", async () => {
  const f = await fixture(),
    shown = await open(f),
    current = await read(f);
  await save(
    f,
    moveMenu(current.data, "printer", "sales", "inside"),
    current.revision,
  );
  const before = await all(
    env,
    "SELECT id FROM outbox WHERE conversation_id=?",
    shown.id,
  );
  const ignored = await receive(f, "1");
  expect(
    await all(env, "SELECT id FROM outbox WHERE conversation_id=?", shown.id),
  ).toEqual(before);
  expect(ignored).toMatchObject({
    menu_parent: "devices",
    menu_active: 1,
    owner: f.actor.id,
  });
  await receive(f, "2");
  expect((await latest(shown.id)).text).toBe("Ajuda do computador");
});

it("mover o submenu aberto mantém seus filhos e VOLTAR acompanha a nova hierarquia", async () => {
  const f = await fixture(),
    shown = await open(f),
    current = await read(f);
  await save(
    f,
    moveMenu(current.data, "devices", "sales", "inside"),
    current.revision,
  );
  const afterMove = await conversation(env, shown.id, f.profile);
  expect(afterMove.menu_items).toBe(shown.menu_items);
  expect(afterMove.menu_token).toBe(shown.menu_token);
  const parent = await receive(f, "VOLTAR");
  expect(parent).toMatchObject({
    menu_parent: "sales",
    state: "human",
    owner: f.actor.id,
  });
  expect(json(parent.menu_items)).toEqual(["quote", "devices"]);
  await receive(f, "Impressora", `wmenu:${shown.menu_token}:printer`);
  expect((await latest(shown.id)).text).toContain("não está mais disponível");
});

it("reorder e reparent exigem revisão atual e autorização sem alterar o último cadastro válido", async () => {
  const f = await fixture(),
    before = await read(f);
  const ordered = reorder(before.data, [
    "sales",
    "quote",
    "support",
    "devices",
    "computer",
    "printer",
  ]);
  await save(f, ordered, before.revision);
  const valid = await read(f),
    moved = moveMenu(ordered, "printer", "sales", "inside");
  await expect(save(f, moved, before.revision)).rejects.toMatchObject({
    status: 409,
    code: "menus_changed",
  });
  await expect(
    perform(
      env,
      { ...f.actor, role: "operator" },
      f.profile,
      "settings",
      { menus: moved, menus_revision: valid.revision },
      uid(),
    ),
  ).rejects.toMatchObject({ status: 403, code: "admin_required" });
  expect(await read(f)).toEqual(valid);
  await save(f, moved, valid.revision);
  expect((await read(f)).data).toEqual(moved);
});
