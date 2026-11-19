// Sem efeito colateral no import. O integrador chama registerCondominio uma vez.
import { all, exec, one } from "../../db";
import { registerCustomerProvider } from "../../customer/ports";
import { condominioCustomerProvider } from "./customer-provider";
import { now, type Conversation } from "../../types";
import {
  onCommand,
  onCredentialClaim,
  onMenuChoice,
  onRead,
  onRoute,
  onSchedule,
  type ModuleContext,
} from "../api";
import {
  fail,
  get,
  id,
  memberships,
  page,
  parse,
  resident,
  selected,
  staff,
  verifiedCustomer,
  verifiedPerson,
  personIdentity,
} from "./common";
import { cadastro, directory } from "./cadastro";
import { createWork, moveWork, workCatalog, workDetail, works } from "./works";
import { listNotices, noticeCommand, sendDueNotices } from "./notices";
import {
  assemblyCommand,
  assemblyDetail,
  attendance,
  ballot,
  electoralRecords,
  listAssemblies,
  results,
  vote,
} from "./assemblies";

export async function openResidentAccess(
  ctx: ModuleContext,
  c: Conversation,
  rowId: string,
) {
  await ctx.requireEnabled();
  const identity = await verifiedCustomer(ctx, c), { phone } = identity;
  const personId = await verifiedPerson(ctx, identity);
  const person = personId ? { person_id: personId } : null;
  if (!person || !(await memberships(ctx, person.person_id)).length) {
    await ctx.sendMessage(
      c,
      {
        text: "Procure a administração para conferir o vínculo do seu telefone com a unidade.",
      },
      { key: `access-missing:${rowId}` },
    );
    return;
  }
  await personIdentity(ctx, c, person.person_id);
  const accessId = `access:${rowId}`;
  await exec(
    ctx.env,
    "INSERT INTO cond_access(profile_id,id,conversation_id,phone,person_id,expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(profile_id,id) DO NOTHING",
    ctx.profile,
    accessId,
    c.id,
    phone,
    person.person_id,
    now() + 75 * 60000,
  );
  let access = await get(ctx, "access", accessId);
  if (access.conversation_id !== c.id || access.person_id !== person.person_id || access.phone !== phone)
    fail("contact_conflict", 409);
  if (!access.claim_url) {
    const claim = await ctx.issueCredential(accessId, {
      actor: `channel:${c.id}`,
      claimMinutes: 15,
      ttlMinutes: 60,
    });
    const url = new URL(claim.url);
    const code = url.pathname.split("/c/")[1];
    if (!code) fail("access_unavailable", 409);
    url.pathname = "/condominio/acesso";
    url.search = "";
    url.hash = code;
    await exec(
      ctx.env,
      "UPDATE cond_access SET claim_url=? WHERE profile_id=? AND id=?",
      url.toString(),
      ctx.profile,
      accessId,
    );
    access = await get(ctx, "access", accessId);
  }
  await ctx.sendMessage(
    c,
    {
      text: `Acesse sua unidade pelo link pessoal, válido para abrir por 15 minutos. Não compartilhe.\n${access.claim_url}`,
    },
    { key: `access:${rowId}` },
  );
}

type Command = Parameters<typeof onCommand>[2];
export function registerCondominio() {
  registerCustomerProvider("condominio", condominioCustomerProvider);
  const command = (
    name: string,
    path: string,
    handler: Command,
    customer = false,
  ) => {
    const op = `condominio.${name}`;
    onRoute("condominio", {
      method: "POST",
      path: `condominio/${path}`,
      op,
      ...(customer ? { credential: true, credentialParam: "access_id" } : {}),
    });
    onCommand("condominio", op, handler);
  };
  for (const [action, path] of Object.entries({
    block: "blocks",
    unit: "units",
    person: "people",
    phone: "phones",
    membership: "memberships",
    asset: "assets",
    "end-membership": "memberships/:id/end",
    "end-phone": "phones/:id/end",
  }))
    command(action, path, (ctx, actor, data, { requestId }) =>
      cadastro(ctx, actor, action, data, requestId),
    );
  for (const kind of [
    "blocks",
    "units",
    "people",
    "phones",
    "memberships",
    "assets",
    "contacts",
  ])
    onRead("condominio", `condominio/${kind}`, (ctx, actor, { query }) =>
      directory(ctx, actor, kind, query),
    );
  onRead("condominio", "condominio/capabilities", async (ctx, actor) => {
    await staff(ctx, actor, ["admin", "mesa", "portaria"]);
    return {
      admin: await ctx.granted(actor, "admin"),
      mesa: await ctx.granted(actor, "mesa"),
      portaria: await ctx.granted(actor, "portaria"),
    };
  });
  onRead("condominio", "condominio/works", (ctx, actor, { query }) =>
    works(ctx, actor, query),
  );
  onRead("condominio", "condominio/work-types", (ctx, actor) =>
    workCatalog(ctx, actor),
  );
  onRead(
    "condominio",
    "condominio/electoral-people",
    async (ctx, actor, { query }) => {
      await staff(ctx, actor, ["admin", "mesa"]);
      return page(
        await all(
          ctx.env,
          "SELECT id,name FROM cond_people WHERE profile_id=? AND id>? ORDER BY id LIMIT 51",
          ctx.profile,
          query.cursor || "",
        ),
      );
    },
  );
  onRead(
    "condominio",
    "condominio/electoral-units",
    async (ctx, actor, { query }) => {
      await staff(ctx, actor, ["admin", "mesa"]);
      return page(
        await all(
          ctx.env,
          "SELECT u.id,u.number,b.name AS block FROM cond_units u JOIN cond_blocks b ON b.profile_id=u.profile_id AND b.id=u.block_id WHERE u.profile_id=? AND u.id>? ORDER BY u.id LIMIT 51",
          ctx.profile,
          query.cursor || "",
        ),
      );
    },
  );
  onRead("condominio", "condominio/works/:id", (ctx, actor, { params }) =>
    workDetail(ctx, actor, params.id),
  );
  command("work", "works", (ctx, actor, data, { requestId }) =>
    createWork(ctx, actor, data, requestId),
  );
  command("stage", "works/:id/stage", (ctx, actor, data, { requestId }) =>
    moveWork(ctx, actor, data, requestId),
  );
  onRead("condominio", "condominio/notices", (ctx, actor, { query }) =>
    listNotices(ctx, actor, query),
  );
  for (const action of ["create", "approve", "send", "retry"])
    command(
      `notice.${action}`,
      action === "create" ? "notices" : `notices/:id/${action}`,
      (ctx, actor, data, { requestId }) =>
        noticeCommand(ctx, actor, action, data, requestId),
    );
  onRead("condominio", "condominio/assemblies", (ctx, actor, { query }) =>
    listAssemblies(ctx, actor, query),
  );
  onRead("condominio", "condominio/assemblies/:id", (ctx, actor, { params }) =>
    assemblyDetail(ctx, actor, params.id),
  );
  for (const kind of ["attendance", "proxies"])
    onRead(
      "condominio",
      `condominio/assemblies/:id/${kind}`,
      (ctx, actor, { params, query }) =>
        electoralRecords(ctx, actor, params.id, kind, query.cursor),
    );
  onRead(
    "condominio",
    "condominio/agenda/:id/results",
    (ctx, actor, { params }) => results(ctx, actor, params.id),
  );
  onRead(
    "condominio",
    "condominio/agenda/:id/electors",
    async (ctx, actor, { params, query }) => {
      await staff(ctx, actor, ["admin", "mesa"]);
      await get(ctx, "agenda", params.id);
      return page(
        await all(
          ctx.env,
          `SELECT e.unit_id AS id,e.weight,p.name AS person_name,b.name||' · '||u.number AS unit_label
      FROM cond_electors e JOIN cond_people p ON p.profile_id=e.profile_id AND p.id=e.person_id
      JOIN cond_units u ON u.profile_id=e.profile_id AND u.id=e.unit_id JOIN cond_blocks b ON b.profile_id=u.profile_id AND b.id=u.block_id
      WHERE e.profile_id=? AND e.agenda_id=? AND e.unit_id>? ORDER BY e.unit_id LIMIT 51`,
          ctx.profile,
          params.id,
          query.cursor || "",
        ),
      );
    },
  );
  const assemblyPaths = {
    create: "assemblies",
    agenda: "assemblies/:id/agenda",
    publish: "assemblies/:id/publish",
    minutes: "assemblies/:id/minutes",
    proxy: "proxies",
    "review-proxy": "proxies/:id/review",
    "revoke-proxy": "proxies/:id/revoke",
    qualify: "agenda/:id/qualify",
    open: "agenda/:id/open",
    close: "agenda/:id/close",
    annul: "agenda/:id/annul",
  };
  for (const [action, path] of Object.entries(assemblyPaths))
    command(`assembly.${action}`, path, (ctx, actor, data, { requestId }) =>
      assemblyCommand(ctx, actor, action, data, requestId),
    );
  command("attendance", "attendance", (ctx, actor, data) =>
    attendance(ctx, actor, data),
  );

  const me = "condominio/me/:access_id";
  const credentials = { credential: true, credentialParam: "access_id" };
  onRead(
    "condominio",
    `${me}/work-types`,
    (ctx, actor, { params }) => workCatalog(ctx, actor, params.access_id),
    credentials,
  );
  onRead(
    "condominio",
    `${me}/units`,
    async (ctx, actor, { params }) => {
      const r = await resident(ctx, actor, params.access_id);
      return {
        data: [
          ...new Map(
            r.units.map((u) => [
              u.unit_id,
              { id: u.unit_id, block: u.block, number: u.number },
            ]),
          ).values(),
        ],
        selected: r.access.selected_unit_id,
      };
    },
    credentials,
  );
  command(
    "me.select",
    "me/:access_id/select",
    async (ctx, actor, data) => {
      const r = await resident(ctx, actor, data.access_id);
      const unit = selected(r, parse(id, data.unit_id));
      await exec(
        ctx.env,
        "UPDATE cond_access SET selected_unit_id=? WHERE profile_id=? AND id=?",
        unit.unit_id,
        ctx.profile,
        r.access.id,
      );
      return { id: unit.unit_id };
    },
    true,
  );
  onRead(
    "condominio",
    `${me}/assets`,
    async (ctx, actor, { params, query }) => {
      const r = await resident(ctx, actor, params.access_id),
        m = selected(r, query.unit_id);
      return page(
        await all(
          ctx.env,
          "SELECT id,kind,label,detail FROM cond_assets WHERE profile_id=? AND unit_id=? AND person_id=? AND id>? ORDER BY id LIMIT 51",
          ctx.profile,
          m.unit_id,
          r.person,
          query.cursor || "",
        ),
      );
    },
    credentials,
  );
  onRead(
    "condominio",
    `${me}/works`,
    (ctx, actor, { params, query }) =>
      works(ctx, actor, query, params.access_id),
    credentials,
  );
  onRead(
    "condominio",
    `${me}/works/:id`,
    (ctx, actor, { params }) =>
      workDetail(ctx, actor, params.id, params.access_id),
    credentials,
  );
  command(
    "me.work",
    "me/:access_id/works",
    (ctx, actor, data, { requestId }) =>
      createWork(ctx, actor, data, requestId, data.access_id),
    true,
  );
  onRead(
    "condominio",
    `${me}/notices`,
    (ctx, actor, { params, query }) =>
      listNotices(ctx, actor, query, params.access_id),
    credentials,
  );
  onRead(
    "condominio",
    `${me}/assemblies`,
    (ctx, actor, { params, query }) =>
      listAssemblies(ctx, actor, query, params.access_id),
    credentials,
  );
  onRead(
    "condominio",
    `${me}/assemblies/:id`,
    (ctx, actor, { params }) =>
      assemblyDetail(ctx, actor, params.id, params.access_id),
    credentials,
  );
  onRead(
    "condominio",
    `${me}/assemblies/:id/units`,
    async (ctx, actor, { params }) => {
      const r = await resident(ctx, actor, params.access_id);
      const assembly = await get(ctx, "assemblies", params.id);
      if (assembly.status === "draft") fail();
      return {
        data: await all(
          ctx.env,
          `SELECT DISTINCT e.unit_id AS id,e.proxy_id,u.number,b.name AS block
      FROM cond_electors e JOIN cond_agenda a ON a.profile_id=e.profile_id AND a.id=e.agenda_id
      JOIN cond_units u ON u.profile_id=e.profile_id AND u.id=e.unit_id JOIN cond_blocks b ON b.profile_id=u.profile_id AND b.id=u.block_id
      WHERE e.profile_id=? AND a.assembly_id=? AND e.person_id=?
      AND (EXISTS(SELECT 1 FROM cond_memberships m WHERE m.profile_id=e.profile_id AND m.id=e.membership_id AND m.person_id=e.person_id AND m.unit_id=e.unit_id AND m.starts_at<=? AND (m.ends_at IS NULL OR m.ends_at>?))
        OR EXISTS(SELECT 1 FROM cond_proxies p WHERE p.profile_id=e.profile_id AND p.id=e.proxy_id AND p.status='approved' AND p.expires_at>?))
      LIMIT 200`,
          ctx.profile,
          params.id,
          r.person,
          now(),
          now(),
          now(),
        ),
      };
    },
    credentials,
  );
  onRead(
    "condominio",
    `${me}/agenda/:id/results`,
    (ctx, actor, { params }) =>
      results(ctx, actor, params.id, params.access_id),
    credentials,
  );
  onRead(
    "condominio",
    `${me}/agenda/:id/ballot`,
    async (ctx, actor, { params, query }) => {
      const { a, e } = await ballot(
        ctx,
        actor,
        params.access_id,
        params.id,
        parse(id, query.unit_id),
      );
      return {
        id: a.id,
        title: a.title,
        unit_id: e.unit_id,
        options: JSON.parse(a.options_json),
        weight: e.weight,
        status: a.status,
        closes_at: a.closes_at,
      };
    },
    credentials,
  );
  command(
    "me.attendance",
    "me/:access_id/attendance",
    (ctx, actor, data) => attendance(ctx, actor, data, data.access_id),
    true,
  );
  command(
    "me.vote",
    "me/:access_id/votes",
    (ctx, actor, data, { requestId }) =>
      vote(ctx, actor, data.access_id, data, requestId),
    true,
  );
  onRead(
    "condominio",
    `${me}/votes/:id`,
    async (ctx, actor, { params }) => {
      const r = await resident(ctx, actor, params.access_id);
      const receipt = await one(
        ctx.env,
        "SELECT id,agenda_id,unit_id,choice,weight,created_at FROM cond_votes WHERE profile_id=? AND id=? AND person_id=?",
        ctx.profile,
        params.id,
        r.person,
      );
      if (!receipt) fail();
      // Revogação do vínculo remove também o acesso ao recibo na unidade.
      if (!r.units.some((u) => u.unit_id === receipt.unit_id)) fail();
      return receipt;
    },
    credentials,
  );
  onMenuChoice("cond_unit", (ctx, c, _item, { rowId }) =>
    openResidentAccess(ctx, c, rowId),
  );
  onCredentialClaim("condominio", async (ctx, credential) => {
    const access = await get(ctx, "access", credential.subject);
    if (access.expires_at <= now()) fail("access_expired", 410);
    const identity = await personIdentity(ctx, await ctx.conversation(access.conversation_id), access.person_id);
    if (identity.phone !== access.phone) fail();
    if (!(await memberships(ctx, access.person_id)).length) fail();
    return { access_id: access.id };
  });
  onSchedule("condominio", (ctx) => sendDueNotices(ctx));
}
