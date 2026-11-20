import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { mountComponent } from "./helpers/component-recovery-harness.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const compiled = await build({
  stdin: { contents: `export {listOrders,visibleOrder} from './src/modules/os/store.ts';
    export {builtinWorkType} from './src/modules/os/work-types.ts';
    export {newWorkType,newField} from './web/modules/os/types/type-draft.ts';`, resolveDir: root, loader: "ts" },
  bundle: true, write: false, platform: "node", format: "esm", logLevel: "silent",
  // Só as funções de leitura são exercitadas aqui; não inicializar registros de
  // módulos/rotas do Worker ao importar a consulta em Node.
  plugins: [{ name: "isolated-read-imports", setup(builder) {
    builder.onResolve({ filter: /^\./ }, async args => {
      if (args.pluginData?.resolved) return;
      const resolved = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { resolved: true } });
      return { ...resolved, sideEffects: false };
    });
  } }],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const classic = m.builtinWorkType();
const custom = () => ({ ...m.newWorkType(), id: "oficina", number_prefix: "OF",
  labels: { ...m.newWorkType().labels, plural: "Serviços de oficina", item: "Veículo", problem: "Solicitação" },
  features: { ...m.newWorkType().features, tasks: true },
});
const row = (id, type) => ({ id, type_id: type.id, type_plural_label: type.labels.plural, display_number: id,
  customer: { name: "Cliente " + id }, item: "Item " + id, status: "received", stage_label: "Recebida", due_at: null, updated: 1,
  extra: { segredo: "PRIVADO_NAO_RENDERIZAR", interno: "INTERNO_NAO_RENDERIZAR" }, fields: [],
});

async function listView(types, { route = {}, rows = [] } = {}) {
  const requests = [], navigations = [];
  const api = { orders: async query => { requests.push(query); return { data: rows, next_cursor: null }; } };
  const resource = { data: { data: rows, next_cursor: null }, reload() {} };
  const view = await mountComponent("../../../modules/os/work/WorkListPage.tsx", { catalog: { data: types } }, {
    componentName: "WorkList", ports: {
      app: { root: "v1/profiles/a", profile: "a", settings: {}, names: {}, isAdmin: true, now: 10 },
      api, resource, route: { area: "erp", page: "work", ...route }, navigations,
    }, modules: {
      "../../../app/AppContext": "export const useApp=()=>r.app;",
      "../../../admin/shared": "export const Pager='pager';",
      "../../../ui": "export const Button='button',Dialog='dialog',Field='field',Empty='empty',Notice='notice';",
      "../../../lib/routes": "export const useRoute=()=>r.route,navigate=route=>r.navigations.push(route),linkProps=route=>({href:route.page,onClick:()=>r.navigations.push(route)});",
      "../work-hooks": "export const useWorkApi=()=>r.api,ResourceState='resource',instantLabel=value=>String(value); export const useWorkResource=(key,load)=>r.useMemo(()=>{load();return r.resource;},[key]);",
      "../ServiceOrdersPage": "export const OrderForm='classic-form',OrderDetail='classic-detail';",
      "./WorkFormDialog": "export const WorkFormDialog='custom-form';",
      "./WorkDetailPage": "export const WorkDetailPage='custom-detail';",
      "../components/StagePill": "export const StagePill='stage';",
    },
  });
  return { view, requests, navigations };
}

test("lista única mostra modelos ativos, colunas comuns e mantém extras fora do DOM", async () => {
  const type = custom(), archived = { ...custom(), id: "arquivado", archived: true };
  const { view, requests } = await listView([classic, type, archived], { rows: [row("1", classic), row("OF-2", type)] });
  try {
    assert.equal(requests.length, 1);
    assert.equal(requests[0].type_id, undefined);
    assert.equal(requests[0].type_ids, "service_order,oficina");
    assert.equal(requests[0].facets, undefined);
    const model = view.find(node => node.type === "field" && node.props.label === "Modelo");
    assert.equal(model.props.emptyOption, "Todos os modelos");
    assert.equal(model.props.value, "");
    assert.equal(model.props.options.length, 2);
    assert.match(view.text(), /NúmeroModeloClienteItemEtapaResponsávelPrazoOrçamentoAtualizada/);
    assert.match(view.text(), /Ordens de serviço/);
    assert.match(view.text(), /Serviços de oficina/);
    assert.match(view.text(), /OF-2/);
    assert.doesNotMatch(view.text(), /PRIVADO_NAO_RENDERIZAR|INTERNO_NAO_RENDERIZAR/);
    assert.equal(view.nodes().some(node => node.type === "field" && node.props.label === "Etapa"), false);
  } finally { view.unmount(); }
});

test("filtro por modelo pré-seleciona URL, usa seu vocabulário e separa situação de etapas", async () => {
  const type = custom();
  const { view, requests, navigations } = await listView([classic, type], {
    route: { typeId: type.id, filters: { status: "delivered", assignee: "me", due_from: "1", due_to: "20", q: "carro" } }, rows: [row("OF-1", type)],
  });
  try {
    assert.equal(requests[0].type_id, type.id);
    assert.equal(requests[0].type_ids, undefined);
    assert.equal(requests[0].status, "delivered");
    assert.equal(requests[0].assignee, "me");
    assert.equal(requests[0].due_to, "20");
    assert.equal(requests[0].q, "carro");
    assert.match(view.text(), /Veículo/);
    const stage = view.find(node => node.type === "field" && node.props.label === "Etapa");
    assert.deepEqual(stage.props.options.map(option => option.id), type.stages.map(stage => stage.id));
    stage.props.onChange(type.initial_stage);
    assert.deepEqual(navigations.at(-1).filters, { q: "carro", status: "", assignee: "me", due_from: "1", due_to: "20", stage: type.initial_stage, open: "0" });
    view.find(node => node.type === "field" && node.props.label === "Modelo").props.onChange("");
    assert.equal(navigations.at(-1).typeId, undefined);
    assert.equal(navigations.at(-1).filters.stage, "");
  } finally { view.unmount(); }
});

test("Nova ordem com um modelo abre o formulário clássico direto e oferece criar modelo", async () => {
  const { view } = await listView([classic]);
  try {
    assert.match(view.text(), /Seu serviço tem informações próprias\? Crie um modelo/);
    await view.click("Nova ordem");
    assert.ok(view.nodes().some(node => node.type === "classic-form"));
    assert.equal(view.nodes().some(node => node.type === "dialog"), false);
  } finally { view.unmount(); }
});

test("Nova ordem com vários modelos pede escolha com descrição e abre seu formulário", async () => {
  const type = custom(), { view } = await listView([classic, type], { route: { typeId: type.id } });
  try {
    await view.click("Nova ordem");
    assert.ok(view.nodes().some(node => node.type === "dialog"));
    assert.match(view.text(), /Veículo · Solicitação/);
    assert.equal(view.nodes().some(node => node.type === "custom-form" || node.type === "classic-form"), false);
    await view.click("Serviços de oficina");
    assert.equal(view.find(node => node.type === "custom-form").props.type, type);
  } finally { view.unmount(); }
});

test("linhas mantêm detalhe clássico em diálogo e personalizado em página", async () => {
  const type = custom(), { view, navigations } = await listView([classic, type], { rows: [row("1", classic), row("OF-2", type)] });
  try {
    const anchors = view.nodes().filter(node => node.type === "a" && ["1", "OF-2"].includes(node.props.children));
    const event = { preventDefault() {} };
    anchors[0].props.onClick(event); await view.flush();
    assert.equal(view.find(node => node.type === "classic-detail").props.id, "1");
    anchors[1].props.onClick(event);
    assert.deepEqual(navigations.at(-1), { area: "admin", page: "work", typeId: type.id, id: "OF-2", filters: {} });
  } finally { view.unmount(); }
});

async function database(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  // Esquema real: a lista confere na mesma leitura o contato das ordens com
  // objeto (contacts, 0005/0130; object_id, 0150).
  const migrations = new URL("../../../migrations/", import.meta.url);
  for (const migration of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort())
    db.exec(await readFile(new URL(migration, migrations), "utf8"));
  const calls = [], ctx = {
    profile: "area", mayRead: actor => actor.kind === "user" && !actor.id.startsWith("bot:"),
    env: { DB: { prepare(sql) { return { bind(...args) { return { async all() {
      calls.push({ sql, args }); return { results: db.prepare(sql).all(...args) };
    } }; } }; } } },
  };
  const type = custom();
  type.fields = [
    { ...m.newField(), id: "publico", label: "Público", client_visible: true },
    { ...m.newField(), id: "interno", label: "Interno", client_visible: false },
    { ...m.newField(), id: "sigilo", label: "Sensível", sensitive: true, client_visible: false },
  ];
  const insert = (number, typeId = "service_order", profile = "area") => db.prepare(`INSERT INTO os_orders
    (id,profile_id,number,item,problem,source,created_by,created,updated,type_id,type_snapshot_json,stage,extra_json,customer_name,phone,notes)
    VALUES(?,?,?,'Veículo','Revisar','panel','pessoa',1,1,?,?,?,?,'Cliente','5511999999999','NOTA_INTERNA')`)
    .run(profile + number, profile, number, typeId, typeId === "service_order" ? null : JSON.stringify({ schema_version: 1, type: { ...type, id: typeId } }),
      typeId === "service_order" ? null : type.initial_stage, JSON.stringify({ publico: "Referência pública", interno: "CAMPO_INTERNO", sigilo: "CAMPO_SENSIVEL" }));
  const human = { id: "pessoa", kind: "user", role: "operator", profiles: ["area"], access: ["os"] };
  return { db, calls, ctx, insert, human, type };
}

test("consulta SQL unificada pagina todos os modelos com índice existente e mede 2–3 leituras", async t => {
  const f = await database(t);
  f.insert(1); f.insert(2, "oficina"); f.insert(3, "arquivado"); f.insert(4, "oficina"); f.insert(99, "oficina", "outra");
  const first = await m.listOrders(f.ctx, { type_ids: "service_order,oficina", limit: "2" }, f.human);
  assert.deepEqual(first.data.map(row => row.number), [4, 2]);
  assert.equal(first.next_cursor, "2");
  assert.equal(f.calls.length, 3);
  const select = f.calls.find(call => call.sql.startsWith("SELECT os_orders.*"));
  const plan = f.db.prepare("EXPLAIN QUERY PLAN " + select.sql).all(...select.args).map(row => row.detail).join(" ");
  assert.match(plan, /USING INDEX (?:os_orders_type_list|sqlite_autoindex_os_orders_\d+)/);
  f.insert(5);
  f.calls.length = 0;
  const second = await m.listOrders(f.ctx, { type_ids: "service_order,oficina", limit: "2", cursor: first.next_cursor }, f.human);
  assert.deepEqual(second.data.map(row => row.number), [1]);
  assert.equal(second.next_cursor, null);
  assert.equal(f.calls.length, 2);
  const filtered = await m.listOrders(f.ctx, { type_id: "oficina", stage: f.type.initial_stage }, f.human);
  assert.deepEqual(filtered.data.map(row => row.number), [4, 2]);
  assert.equal((await m.listOrders(f.ctx, {}, f.human)).data.some(row => row.type_id === "arquivado"), true);
  await assert.rejects(m.listOrders(f.ctx, { type_ids: "oficina,' OR 1=1" }, f.human));
});

test("lista unificada conserva projeções, não busca extras nem revela tarefas privadas", async t => {
  const f = await database(t);
  f.insert(1); f.insert(2, "oficina");
  f.db.prepare(`INSERT INTO os_tasks(id,profile_id,order_id,title,sensitive,client_visible,due_at,created_by,created,updated)
    VALUES('privada','area','area2','TAREFA_SENSIVEL',1,0,1,'pessoa',1,1),
    ('interna','area','area2','TAREFA_INTERNA',0,0,2,'pessoa',1,1),
    ('publica','area','area2','Tarefa pública',0,1,3,'pessoa',1,1)`).run();
  const list = await m.listOrders(f.ctx, { type_ids: "service_order,oficina" }, f.human);
  const human = list.data.map(row => m.visibleOrder(f.ctx, f.human, row));
  assert.doesNotMatch(JSON.stringify(human), /CAMPO_SENSIVEL|TAREFA_SENSIVEL/);
  assert.equal(human.find(row => row.type_id === "oficina").next_task.title, "TAREFA_INTERNA");
  const bot = { ...f.human, id: "bot:assistente" };
  const botList = await m.listOrders(f.ctx, { type_ids: "service_order,oficina" }, bot);
  const projected = botList.data.map(row => m.visibleOrder(f.ctx, bot, row));
  assert.doesNotMatch(JSON.stringify(projected), /CAMPO_SENSIVEL|CAMPO_INTERNO|TAREFA_SENSIVEL|TAREFA_INTERNA|NOTA_INTERNA|5511999999999/);
  for (const q of ["CAMPO_SENSIVEL", "CAMPO_INTERNO", "TAREFA_SENSIVEL"])
    assert.deepEqual((await m.listOrders(f.ctx, { type_ids: "service_order,oficina", q }, bot)).data, []);
});
