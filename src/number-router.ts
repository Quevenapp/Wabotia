import { all, one, exec, batch } from "./db";
import { Env, Actor, ApiError, json, uid, now, requireValue } from "./types";
import { access, admin, random } from "./security";
import { numberUsage } from "./number-quota";
import { conversation, enqueue, perform } from "./service";
import { outgoingContent } from "./whatsapp";
import { paidTemplate } from "./router-templates";
import { event } from "./events";
import {
  numberPolicy,
  numberPolicyFlags,
  deniedNumberCapability,
} from "./number-policy";
import { numberPolicyError } from "./number-permissions";

export async function sourceAllowed(
  env: Env,
  actor: Actor,
  profile: string,
  type: string,
  id: string,
  paid = false,
) {
  access(actor, profile, "routing:read");
  if (actor.kind !== "app") return true;
  return !!(await one(
    env,
    "SELECT source_id FROM number_router_grants WHERE app_id=? AND profile_id=? AND source_type=? AND source_id=? AND (?=0 OR allow_paid=1)",
    actor.id.replace(/^app:/, ""),
    profile,
    type,
    id,
    paid ? 1 : 0,
  ));
}
export async function managedAppAllowed(
  env: Env,
  actorId: string,
  connection: string,
  source?: any,
  paid = false,
) {
  if (!actorId.startsWith("app:")) return true;
  const appId = actorId.slice(4);
  const app = await one(
    env,
    "SELECT * FROM applications WHERE id=? AND disabled=0",
    appId,
  );
  const conn = await one(
    env,
    "SELECT profile_id,config FROM connections WHERE id=?",
    connection,
  );
  if (
    !app ||
    !conn ||
    !numberPolicy(json(conn.config)).api ||
    !json(app.profiles, []).includes(conn.profile_id) ||
    !json(app.scopes, []).includes("routing:send") ||
    (paid && !json(app.scopes, []).includes("routing:paid"))
  )
    return false;
  return !!(await one(
    env,
    `SELECT g.source_id FROM number_router_grants g WHERE g.app_id=? AND g.profile_id=? AND (?=0 OR g.allow_paid=1) AND (?='' OR (g.source_type=? AND g.source_id=?)) AND ((g.source_type='number' AND g.source_id=?) OR (g.source_type='pool' AND EXISTS(SELECT 1 FROM number_pools p JOIN number_pool_members m ON m.pool_id=p.id WHERE p.id=g.source_id AND p.enabled=1 AND (?=0 OR p.allow_paid=1) AND m.connection_id=?))) LIMIT 1`,
    appId,
    conn.profile_id,
    paid ? 1 : 0,
    source?.type || "",
    source?.type || "",
    source?.id || "",
    connection,
    paid ? 1 : 0,
    connection,
  ));
}
async function numbers(env: Env, profile: string) {
  return all(
    env,
    `SELECT c.*,n.account_id,n.phone_id,n.service_limit,n.baseline_period,n.baseline_used FROM connections c JOIN meta_numbers n ON n.connection_id=c.id WHERE c.profile_id=? ORDER BY c.created,c.id`,
    profile,
  );
}
export async function routerView(env: Env, actor: Actor, profile: string) {
  access(actor, profile, "routing:read");
  const found = await numbers(env, profile),
    visibleNumbers = new Set<string>();
  const pools: any[] = [];
  for (const pool of await all(
    env,
    "SELECT * FROM number_pools WHERE profile_id=? ORDER BY created,id LIMIT 100",
    profile,
  )) {
    if (!(await sourceAllowed(env, actor, profile, "pool", pool.id))) continue;
    pool.members = (
      await all(
        env,
        "SELECT connection_id FROM number_pool_members WHERE pool_id=? ORDER BY connection_id",
        pool.id,
      )
    ).map((r: any) => r.connection_id);
    pool.members.forEach((id: string) => visibleNumbers.add(id));
    if (actor.kind === "app") delete pool.public_token;
    pools.push(pool);
  }
  const list = [];
  for (const n of found) {
    const direct = await sourceAllowed(env, actor, profile, "number", n.id);
    if (!direct && !visibleNumbers.has(n.id)) continue;
    const cfg = json(n.config);
    list.push({
      id: n.id,
      name: n.name,
      number: cfg.number,
      phone_id: n.phone_id,
      account_id: n.account_id,
      status: n.status,
      direct_allowed: direct,
      policy: numberPolicy(cfg),
      usage: await numberUsage(env, n.id),
    });
  }
  const result: any = { numbers: list, pools };
  if (actor.role === "admin" && actor.kind === "user") {
    result.accounts = await all(
      env,
      "SELECT * FROM meta_accounts WHERE profile_id=? ORDER BY created,id",
      profile,
    );
    result.applications = await all(
      env,
      "SELECT id,name,scopes,disabled FROM applications WHERE EXISTS(SELECT 1 FROM json_each(applications.profiles) WHERE value=?) ORDER BY name,id",
      profile,
    );
    result.grants = await all(
      env,
      "SELECT * FROM number_router_grants WHERE profile_id=?",
      profile,
    );
  }
  return result;
}
export async function selectPoolNumbers(
  env: Env,
  profile: string,
  poolId: string,
  paid = false,
  actor?: Actor,
) {
  const pool = await one(
    env,
    "SELECT * FROM number_pools WHERE id=? AND profile_id=? AND enabled=1",
    poolId,
    profile,
  );
  if (paid && pool && !pool.allow_paid)
    throw new ApiError(
      403,
      "paid_disabled",
      "O administrador não habilitou modelos pagos neste grupo.",
    );
  if (!pool)
    throw new ApiError(
      409,
      "pool_unavailable",
      "Grupo de números não encontrado ou pausado.",
    );
  const candidates = [];
  for (const row of await all(
    env,
    "SELECT c.*,m.last_selected FROM connections c JOIN number_pool_members m ON m.connection_id=c.id JOIN meta_numbers n ON n.connection_id=c.id WHERE m.pool_id=? AND c.profile_id=? AND c.status='active' AND n.account_id=?",
    pool.id,
    profile,
    pool.account_id,
  )) {
    const policy = numberPolicy(json(row.config));
    if (!policy.pool || !(paid ? policy.templates : policy.service)) continue;
    if (actor && !(actor.kind === "app" ? policy.api : policy.human)) continue;
    const usage = await numberUsage(env, row.id);
    if (usage && (paid || usage.remaining > 0))
      candidates.push({
        ...row,
        usage,
        draw: crypto.getRandomValues(new Uint32Array(1))[0],
      });
  }
  candidates.sort((a, b) =>
    pool.strategy === "random"
      ? a.draw - b.draw
      : pool.strategy === "round_robin"
        ? a.last_selected - b.last_selected || a.id.localeCompare(b.id)
        : a.usage.used - b.usage.used ||
          a.last_selected - b.last_selected ||
          a.id.localeCompare(b.id),
  );
  return candidates;
}
async function selected(env: Env, poolId: string, connection: string) {
  await exec(
    env,
    "UPDATE number_pool_members SET last_selected=(SELECT coalesce(max(last_selected),0)+1 FROM number_pool_members WHERE pool_id=?) WHERE pool_id=? AND connection_id=?",
    poolId,
    poolId,
    connection,
  );
}
export async function routerLink(env: Env, profile: string, token: string) {
  const pool = await one(
    env,
    "SELECT id FROM number_pools WHERE profile_id=? AND public_token=? AND enabled=1",
    profile,
    token,
  );
  requireValue(pool, "Link de atendimento indisponível.");
  const choice = (await selectPoolNumbers(env, profile, pool.id))[0];
  if (!choice)
    throw new ApiError(
      409,
      "pool_exhausted",
      "Nenhum número ativo com permissão de roteamento, atendimento e saldo disponível neste grupo.",
    );
  await selected(env, pool.id, choice.id);
  return { url: `https://wa.me/${json(choice.config).number}` };
}
export async function routerCommand(
  env: Env,
  actor: Actor,
  profile: string,
  op: string,
  data: any,
  key: string,
) {
  access(actor, profile, "routing:read");
  if (op === "router.send") return routedSend(env, actor, profile, data, key);
  if (op === "router.cancel") {
    access(actor, profile, "routing:send");
    const row = await routedMessage(env, actor, profile, data.id);
    const owner = await one(env, "SELECT actor FROM outbox WHERE id=?", row.id);
    if (actor.role !== "admin" && owner?.actor !== actor.id)
      throw new ApiError(
        403,
        "not_owner",
        "Somente o autor ou administrador pode cancelar este envio.",
      );
    requireValue(
      row.status === "pending",
      "Só é possível cancelar uma mensagem que ainda está na fila.",
    );
    const result = await exec(
      env,
      "UPDATE outbox SET status='cancelled',error='Cancelada antes do envio.',updated=? WHERE id=? AND status='pending'",
      now(),
      row.id,
    );
    if (!result.meta.changes)
      throw new ApiError(
        409,
        "delivery_changed",
        "O envio já começou. Consulte o estado; não tente outro remetente.",
      );
    return { id: row.id, status: "cancelled" };
  }
  admin(actor);
  if (op === "router.number.policy") {
    const policy = data.policy;
    requireValue(
      policy && typeof policy === "object" && !Array.isArray(policy),
      "Informe as permissões do número.",
    );
    requireValue(
      ["official", "service_only", "custom"].includes(policy.purpose) &&
        numberPolicyFlags.every((flag) => typeof policy[flag] === "boolean") &&
        Object.keys(policy).every(
          (key) => key === "purpose" || numberPolicyFlags.includes(key as any),
        ),
      "Informe a função e todas as opções como verdadeiro ou falso.",
    );
    const row = await one(
      env,
      "SELECT c.id FROM connections c JOIN meta_numbers n ON n.connection_id=c.id WHERE c.id=? AND c.profile_id=?",
      data.id,
      profile,
    );
    requireValue(row, "Número não encontrado neste perfil.");
    await exec(
      env,
      "UPDATE connections SET config=json_set(config,'$.number_policy',json(?)) WHERE id=?",
      JSON.stringify(policy),
      row.id,
    );
    // Pending sends are checked again by deliver; an in-flight/ambiguous send
    // must keep its receipt and reservation, never be retried on another number.
    return { id: row.id, policy };
  }
  if (op === "router.pool.save") {
    const id = data.id || uid(),
      old = await one(env, "SELECT * FROM number_pools WHERE id=?", id);
    requireValue(!old || old.profile_id === profile, "Grupo de outro perfil.");
    const account = await one(
      env,
      "SELECT id FROM meta_accounts WHERE id=? AND profile_id=?",
      data.account_id,
      profile,
    );
    requireValue(account, "Selecione a conta Meta.");
    const name = String(data.name || "").trim(),
      strategy = data.strategy || "least_used";
    requireValue(
      name.length > 0 && name.length <= 100,
      "Informe o nome do grupo.",
    );
    requireValue(
      ["least_used", "round_robin", "random"].includes(strategy),
      "Estratégia inválida.",
    );
    requireValue(
      Array.isArray(data.members) &&
        data.members.length > 0 &&
        data.members.length <= 20 &&
        new Set(data.members).size === data.members.length,
      "Selecione de 1 a 20 números diferentes.",
    );
    for (const member of data.members)
      requireValue(
        await one(
          env,
          "SELECT connection_id FROM meta_numbers WHERE connection_id=? AND account_id=?",
          member,
          account.id,
        ),
        "Todos os números devem pertencer à mesma conta Meta.",
      );
    const count = await one(
      env,
      "SELECT count(*) n FROM number_pools WHERE profile_id=?",
      profile,
    );
    requireValue(old || count.n < 100, "Limite de 100 grupos por perfil.");
    const publicToken = data.public_enabled
      ? old?.public_token || random()
      : null;
    const writes: [string, any[]][] = [
      [
        "INSERT INTO number_pools(id,profile_id,account_id,name,strategy,enabled,allow_paid,public_token,created) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,name=excluded.name,strategy=excluded.strategy,enabled=excluded.enabled,allow_paid=excluded.allow_paid,public_token=excluded.public_token",
        [
          id,
          profile,
          account.id,
          name,
          strategy,
          data.enabled ? 1 : 0,
          data.allow_paid ? 1 : 0,
          publicToken,
          now(),
        ],
      ],
      [
        "DELETE FROM number_pool_members WHERE pool_id=? AND connection_id NOT IN (SELECT value FROM json_each(?))",
        [id, JSON.stringify(data.members)],
      ],
    ];
    for (const member of data.members)
      writes.push([
        "INSERT OR IGNORE INTO number_pool_members(pool_id,connection_id) VALUES(?,?)",
        [id, member],
      ]);
    await batch(env, writes);
    return {
      id,
      public_path: publicToken ? `/api/public/whatsapp/${publicToken}` : null,
    };
  }
  if (op === "router.grants.save") {
    const app = await one(
      env,
      "SELECT * FROM applications WHERE id=?",
      data.app_id,
    );
    requireValue(
      app && json(app.profiles, []).includes(profile),
      "A aplicação precisa estar autorizada neste perfil.",
    );
    requireValue(
      Array.isArray(data.numbers) &&
        data.numbers.length <= 100 &&
        Array.isArray(data.pools) &&
        data.pools.length <= 100,
      "Permissões inválidas.",
    );
    const writes: [string, any[]][] = [
      [
        "DELETE FROM number_router_grants WHERE app_id=? AND profile_id=?",
        [app.id, profile],
      ],
    ];
    for (const [type, ids] of [
      ["number", data.numbers],
      ["pool", data.pools],
    ] as const)
      for (const id of new Set(ids)) {
        const item =
          type === "number"
            ? await one(
                env,
                "SELECT c.id FROM connections c JOIN meta_numbers n ON n.connection_id=c.id WHERE c.id=? AND c.profile_id=?",
                id,
                profile,
              )
            : await one(
                env,
                "SELECT id FROM number_pools WHERE id=? AND profile_id=?",
                id,
                profile,
              );
        requireValue(item, "Origem não encontrada neste perfil.");
        writes.push([
          "INSERT INTO number_router_grants(app_id,profile_id,source_type,source_id,allow_paid) VALUES(?,?,?,?,?)",
          [app.id, profile, type, id, data.allow_paid ? 1 : 0],
        ]);
      }
    if (data.enable_scopes === true)
      writes.push([
        "UPDATE applications SET scopes=? WHERE id=?",
        [
          JSON.stringify([
            ...new Set([
              ...json(app.scopes, []),
              "routing:read",
              "routing:send",
              "conversations:read",
              "conversations:write",
              ...(data.allow_paid ? ["routing:paid"] : []),
            ]),
          ]),
          app.id,
        ],
      ]);
    await batch(env, writes);
    return { saved: true };
  }
  if (op === "router.number.limit") {
    const limit = Number(data.service_limit);
    requireValue(
      Number.isSafeInteger(limit) && limit >= 0 && limit <= 1000,
      "Use um teto entre 0 e 1.000.",
    );
    const row = await one(
      env,
      "SELECT n.connection_id FROM meta_numbers n JOIN connections c ON c.id=n.connection_id WHERE n.connection_id=? AND c.profile_id=?",
      data.id,
      profile,
    );
    requireValue(row, "Número não encontrado.");
    await exec(
      env,
      "UPDATE meta_numbers SET service_limit=? WHERE connection_id=?",
      limit,
      row.connection_id,
    );
    return {
      id: row.connection_id,
      usage: await numberUsage(env, row.connection_id),
    };
  }
  throw new ApiError(400, "unknown_action", "Operação do roteador inválida.");
}
export async function routedMessage(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  access(actor, profile, "routing:read");
  const row = await one(
    env,
    "SELECT o.*,u.status provider_status,u.category provider_category,u.billable FROM outbox o LEFT JOIN meta_message_usage u ON u.connection_id=o.connection_id AND u.external_id=o.external_id WHERE o.id=? AND o.profile_id=? AND json_extract(o.payload,'$.router_source') IS NOT NULL",
    id,
    profile,
  );
  if (!row || (actor.kind === "app" && row.actor !== actor.id))
    throw new ApiError(404, "not_found", "Envio não encontrado.");
  await conversation(env, row.conversation_id, profile, actor);
  const payload = json(row.payload);
  return {
    id: row.id,
    delivery_id: row.id,
    conversation_id: row.conversation_id,
    number_id: row.connection_id,
    status: row.status,
    provider_status: row.provider_status || null,
    provider_category: row.provider_category || null,
    billable: row.billable === null ? null : !!row.billable,
    error: row.error,
    source: payload.router_source,
    created: row.created,
    updated: row.updated,
  };
}
async function routedSend(
  env: Env,
  actor: Actor,
  profile: string,
  data: any,
  key: string,
) {
  access(actor, profile, "routing:send");
  access(actor, profile, "conversations:write");
  requireValue(
    !!data.number_id !== !!data.pool_id,
    "Escolha number_id ou pool_id, nunca ambos.",
  );
  requireValue(
    typeof (data.number_id || data.pool_id) === "string",
    "Informe o identificador do número ou grupo.",
  );
  const paid = !!data.template;
  if (paid) {
    access(actor, profile, "routing:paid");
    requireValue(
      data.allow_paid === true,
      "Declare allow_paid: true neste pedido para autorizar possível cobrança.",
    );
    requireValue(
      !data.text &&
        !data.content &&
        (!data.attachments || data.attachments.length === 0),
      "Use somente os componentes do modelo para um envio pago.",
    );
  }
  const type = data.number_id ? "number" : "pool",
    source = data.number_id || data.pool_id;
  if (!(await sourceAllowed(env, actor, profile, type, source, paid)))
    throw new ApiError(
      403,
      "source_not_allowed",
      "Número ou grupo não autorizado para esta aplicação e tipo de envio.",
    );
  requireValue(
    typeof data.external_id === "string" &&
      data.external_id.trim() &&
      data.external_id.length <= 200,
    "Informe external_id estável para este atendimento na sua aplicação.",
  );
  const existing = await one(
    env,
    "SELECT * FROM router_affinities WHERE profile_id=? AND actor=? AND external_id=?",
    profile,
    actor.id,
    data.external_id,
  );
  if (
    existing &&
    (existing.source_type !== type || existing.source_id !== source)
  )
    throw new ApiError(
      409,
      "sender_pinned",
      "Este atendimento já tem remetente e origem definidos.",
    );
  const candidates =
    type === "pool"
      ? await selectPoolNumbers(env, profile, source, paid, actor)
      : await all(
          env,
          "SELECT c.* FROM connections c JOIN meta_numbers n ON n.connection_id=c.id WHERE c.id=? AND c.profile_id=? AND c.status='active'",
          source,
          profile,
        );
  if (type === "number" && candidates[0]) {
    const denied = deniedNumberCapability(
      numberPolicy(json(candidates[0].config)),
      actor.id,
      paid ? "template" : "text",
      {},
    );
    if (denied) throw numberPolicyError(denied);
  }
  const pinned = existing?.conversation_id || data.conversation_id;
  let c: any, chosen: any;
  if (pinned) {
    c = await conversation(env, pinned, profile, actor);
    if (
      existing &&
      data.conversation_id &&
      existing.conversation_id !== data.conversation_id
    )
      throw new ApiError(
        409,
        "sender_pinned",
        "Não troque a conversa deste identificador externo.",
      );
    const belongs =
      type === "number"
        ? c.connection_id === source
        : await one(
            env,
            "SELECT connection_id FROM number_pool_members WHERE pool_id=? AND connection_id=?",
            source,
            c.connection_id,
          );
    requireValue(belongs, "A conversa não pertence à origem escolhida.");
    chosen = candidates.find((n) => n.id === c.connection_id);
    if (!chosen)
      throw new ApiError(
        409,
        "sender_unavailable",
        "O remetente deste atendimento está pausado, sem cota ou sem permissão para este envio. Ele não será trocado automaticamente.",
      );
    requireValue(
      !data.to || data.to === (c.recipient_id || c.external_id),
      "Destinatário diferente da conversa.",
    );
  } else {
    requireValue(
      typeof data.to === "string" && /^\d{8,16}$/.test(data.to),
      "Informe to com DDI e DDD, somente dígitos.",
    );
    for (const n of candidates) {
      const bound = await one(
        env,
        "SELECT actor,external_id FROM router_affinities WHERE connection_id=? AND recipient=?",
        n.id,
        data.to,
      );
      if (bound) continue;
      c = await one(
        env,
        "SELECT * FROM conversations WHERE profile_id=? AND connection_id=? AND external_namespace=? AND external_id=? AND chat_type='direct' AND (owner IS NULL OR owner=?) AND (?=1 OR last_customer>?) LIMIT 1",
        profile,
        n.id,
        "channel:" + n.id,
        data.to,
        actor.id,
        paid ? 1 : 0,
        now() - 86400000,
      );
      if (c) {
        chosen = n;
        break;
      }
      if (
        paid &&
        !(await one(
          env,
          "SELECT id FROM conversations WHERE connection_id=? AND coalesce(recipient_id,external_id)=?",
          n.id,
          data.to,
        ))
      ) {
        chosen = n;
        break;
      }
    }
  }
  if (!chosen)
    throw new ApiError(
      409,
      "no_eligible_sender",
      paid
        ? "Nenhum remetente disponível; confira números ativos e atendimentos já vinculados."
        : "Não há número disponível com janela de atendimento aberta para este cliente. Use o link do grupo para o cliente iniciar contato.",
    );
  if (c) {
    requireValue(
      c.chat_type === "direct",
      "O roteador atende conversas individuais.",
    );
    if (c.owner && c.owner !== actor.id)
      throw new ApiError(
        409,
        "already_claimed",
        "Outro responsável assumiu este atendimento.",
      );
    const binding = await one(
      env,
      "SELECT actor,external_id FROM router_affinities WHERE connection_id=? AND recipient=?",
      chosen.id,
      c.recipient_id || c.external_id,
    );
    if (
      binding &&
      (binding.actor !== actor.id || binding.external_id !== data.external_id)
    )
      throw new ApiError(
        409,
        "recipient_bound",
        "Este destinatário já possui atendimento vinculado neste número.",
      );
  }
  let payload: any;
  if (paid) {
    if (c) {
      const consent = await one(
        env,
        "SELECT status FROM consents WHERE conversation_id=? ORDER BY created DESC,rowid DESC LIMIT 1",
        c.id,
      );
      if (["denied", "revoked", "declined"].includes(consent?.status))
        throw new ApiError(
          403,
          "consent_revoked",
          "O cliente retirou o consentimento. A API não pode substituí-lo por uma declaração.",
        );
    }
    payload = await paidTemplate(env, actor, chosen, data);
  } else {
    requireValue(
      c && now() - c.last_customer < 86400000,
      "O cliente precisa enviar mensagem para este mesmo número nas últimas 24 horas.",
    );
    const attachments = data.attachments || [];
    requireValue(
      Array.isArray(attachments) && attachments.length <= 1,
      "Envie no máximo um anexo por pedido do roteador.",
    );
    const content = await outgoingContent(env, actor, c, data);
    if (attachments.length && String(data.text || "").trim()) {
      const media = await one(
        env,
        "SELECT type FROM media WHERE id=?",
        attachments[0],
      );
      requireValue(
        !["audio", "voice", "sticker"].includes(content.type) &&
          !/^audio\//.test(media?.type || "") &&
          media?.type !== "image/webp",
        "Envie texto separado para áudio, voz ou figurinha.",
      );
    }
    const usage = await numberUsage(env, c.connection_id);
    if (!usage || usage.remaining < 1)
      throw new ApiError(
        409,
        "number_quota_exhausted",
        "A cota deste número foi atingida.",
      );
    payload = { text: String(data.text || "").trim(), attachments, content };
  }
  if (!c) {
    requireValue(
      !(await one(
        env,
        "SELECT id FROM conversations WHERE profile_id=? AND external_namespace=? AND external_id=?",
        profile,
        `app:${actor.id}`,
        data.external_id,
      )),
      "Identificador externo já utilizado em outra conversa.",
    );
    const id = uid();
    await exec(
      env,
      "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,recipient_id,phone,state,owner,session,last_customer,created,updated) VALUES(?,?,?,?,?,?,?,'human',?,?,0,?,?)",
      id,
      profile,
      chosen.id,
      `app:${actor.id}`,
      data.external_id,
      data.to,
      data.to,
      actor.id,
      uid(),
      now(),
      now(),
    );
    c = await conversation(env, id, profile, actor);
    await event(env, profile, "conversation.created", id, {
      id,
      external_id: data.external_id,
    });
  }
  if (paid)
    await exec(
      env,
      "INSERT INTO consents(id,profile_id,conversation_id,status,evidence,created) VALUES(?,?,?,'granted',?,?)",
      uid(),
      profile,
      c.id,
      JSON.stringify({
        source: "integration",
        ...payload.paid_authorization,
        recipient: c.recipient_id || c.external_id,
      }),
      now(),
    );
  await perform(
    env,
    actor,
    profile,
    "conversation.action",
    { id: c.id, action: "claim" },
    key,
  );
  c = await conversation(env, c.id, profile, actor);
  await exec(
    env,
    "INSERT OR IGNORE INTO router_affinities(profile_id,actor,external_id,source_type,source_id,conversation_id,connection_id,recipient,created) VALUES(?,?,?,?,?,?,?,?,?)",
    profile,
    actor.id,
    data.external_id,
    type,
    source,
    c.id,
    chosen.id,
    c.recipient_id || c.external_id,
    now(),
  );
  const delivery = await enqueue(
    env,
    c,
    actor.id,
    paid ? "template" : "text",
    { ...payload, router_source: { type, id: source } },
    `router:${actor.id}:${key}`,
  );
  if (type === "pool") await selected(env, source, c.connection_id);
  return {
    delivery_id: delivery,
    conversation_id: c.id,
    number_id: c.connection_id,
    source_type: type,
    source_id: source,
    status: "pending",
    billing: paid
      ? {
          mode: "paid_template",
          authorized: true,
          category: payload.paid_authorization.category,
        }
      : { mode: "service_allowance" },
    usage: await numberUsage(env, c.connection_id),
  };
}
