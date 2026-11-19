import { ensinoNoStore } from "./modules/ensino/http";
import { mountInternalApi, takeInternalActor } from "./internal-api";
import { capabilities } from "./whatsapp";
import { authorizedMedia, mediaResponse, uploadPart, mediaKind } from "./media";
import { callView, callPermission } from "./calls";
import {
  zernioCredentials,
  zernioInbound,
  verifyZernioWebhook,
} from "./zernio";
import { routerView, routedMessage, routerCommand } from "./number-router";
import { zernioAccountCommand } from "./zernio-accounts";
import { templateCatalog } from "./router-templates";
import { listLines, listMenus } from "./line-service";
import {
  teamDirectory,
  areaGrants,
  areaPeople,
  listInternalChats,
  internalChatDetail,
  runQuestion,
} from "./team";
import { MAX_DEVICES_PER_USER } from "./mobile-limits";
import { report } from "./reports";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  isBound,
  visibleEvent,
  visibleConversation,
} from "./visibility";
import { setCookie, deleteCookie } from "hono/cookie";
import {
  type Bindings,
  type Env,
  type Actor,
  ApiError,
  uid,
  now,
  json,
  requireValue,
} from "./types";
import { all, one, exec, batch, withReadCache } from "./db";
import { documentText } from "./knowledge";
import {
  ensureInstallationArea,
  installationAreaInsert,
} from "./installation-area";
import {
  authenticate,
  access,
  admin,
  canProfile,
  sha,
  random,
  passwordHash,
  passwordMatches,
  rate,
  secret,
  setSecret,
  equal,
  hmac,
  hex,
  MOBILE_TOKEN_PREFIX,
} from "./security";
import { aiListModels } from "./ai-provider";
import { pushConfig, publicPushConfig, sendTest, prunePush } from "./push";
import { wake } from "./events";
import { settings, settingsRevision, scopes, eventTypes, conversation, perform } from "./service";
import {
  probe,
  storeRemoteMedia,
  telegramRemoved,
} from "./integrations";
import { openapi } from "./openapi";
import { ticketStatuses, activeTicketSql } from "./protocols";
import { listServiceTemplates } from "./service-templates";
import {
  approvalView,
  decideApproval,
  listApprovals,
  loadApproval,
} from "./approvals";
import {
  cancelProposal,
  confirmProposal,
  fullPersonalData,
  setFullPersonalData,
} from "./bot-actions/actions";
import { mountAccount, mountAccountPublic } from "./account-routes";
import { loginMfaNext, loginSecondFactor, mfaGate } from "./mfa";
import { buildInfo } from "./build-info.generated";
import { sourceInfo } from "./source";
import {
  listContacts,
  contactDetail,
  recoverContactCommand,
  conversationContact,
  contactNamespace,
  previewContactCsv,
} from "./contacts";
import { checkUpdate, updateStatus } from "./updates";
import {
  OFFICIAL_RELEASE_ORIGIN,
  RELEASE_ORIGIN,
  TEST_CATALOG_PATH,
  TEST_CATALOG_PREFIX,
} from "./release";
import { removePendingConnections } from "./connection-removal";
import {
  pairingStart,
  pairingToken,
  pairingList,
  pairingLookup,
  pairingApprove,
  pairingDeny,
  pairingRevoke,
  pairingDisconnect,
  prunePairings,
} from "./pairing";
import { installStep, webInstallerEnabled } from "./web-install";
import {
  listModules,
  moduleById,
  moduleEnabled,
  moduleForRoute,
  moduleStates,
  requireModule,
} from "./modules/registry";
import {
  accessCatalog,
  allows,
  presetsFor,
  requireRouteAccess,
  requireAccess,
} from "./access";
import {
  formInput,
  formPage,
  getWebStep,
  listWebSteps,
  publicOrigin,
  rememberOrigin,
  statePage,
  appInvitePage,
  stepFor,
  touchWebStep,
  webStepByCode,
  webStepView,
  whatsappReturnLink,
} from "./web-steps";
import { emailReady } from "./email";
import { trackPage } from "./web-track";
import {
  CLAIM_PATH,
  claimOwner,
  ipHash,
  peekClaim,
} from "./module-credentials";
import { credentialGate, matchModuleRoute, moduleRoutes, routeData, webStepPageHook } from "./modules/hooks";
import { paymentView, verifyPaymentWebhook } from "./payments";
import {
  addCartSlot,
  cartInput,
  cartReviewPage,
  validateCartOrder,
  catalogMedia,
} from "./web-cart";
// Carrega os módulos embutidos antes de montar as rotas que eles declaram.
import "./modules/runtime";
import { capabilities as serverCapabilities } from "./modules/capabilities";
import { establishment } from "./establishment";
import { erpApi, erpProbe } from "./erp/api/local-fetch";
import { customerRead, contactConflicts, customerResponse } from "./customer/http";
import { readJob } from "./customer/jobs";
import { wakeErpAreas } from "./erp/scheduler/cron";
import { erpSignedDownload } from "./erp-storage";
import {
  ERP_APPS_SQL,
  ERP_PEOPLE_SQL,
  erpIdentity,
  isErpPath,
} from "./modules/erp/identity";
import {
  appProfiles,
  closeSockets,
  credentialTags,
  userProfiles,
} from "./sockets";
import {
  queueRead,
  overview as queueOverview,
  listTickets as listQueueTickets,
  getTicket as getQueueTicket,
  listBlocklist,
  listDisplays,
  displayByToken,
  publicTicket,
  SEND_HINT_PATH,
} from "./queue";
import { sendHintPage } from "./send-hint";

/** Hands a WebSocket upgrade to the area's Coordinator (one per area). */
function queueSocket(
  env: Env,
  request: Request,
  profile: string,
  filter: string[],
  credential: string[],
  expiresAt?: number,
) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    throw new ApiError(426, "upgrade_required", "Use WebSocket nesta rota.");
  const headers = new Headers(request.headers);
  headers.set("X-Wabotia-Profile", profile);
  headers.set("X-Wabotia-Queues", JSON.stringify(filter));
  // Quem abriu: a revogação fecha o socket na hora (src/sockets.ts).
  headers.set("X-Wabotia-Credential", JSON.stringify(credential));
  // Validade da credencial: o Coordinator fecha o socket quando vencer.
  if (expiresAt) headers.set("X-Wabotia-Expires", String(expiresAt));
  else headers.delete("X-Wabotia-Expires");
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(profile)).fetch(
    new Request("https://coordinator/queue-ws", { method: "GET", headers }),
  );
}


export { Coordinator } from "./coordinator";
const app = new Hono<Bindings>();
app.use("/api/v1/profiles/:profile/ensino/*", ensinoNoStore);
app.use("*", async (c, next) => {
  if (/^\/internal\/v1\/connectors\/[^/]+\/media-content$/.test(c.req.path))
    return next();
  return bodyLimit({
    maxSize: 21 * 1024 * 1024,
    onError: (c) =>
      c.json(
        {
          error: {
            code: "payload_too_large",
            message: "Limite de 20 MB por arquivo.",
          },
        },
        413,
      ),
  })(c, next);
});
app.use("*", async (c, next) => {
  c.set("requestId", uid());
  await next();
  c.header("X-Request-Id", c.get("requestId"));
  if (c.res.status === 429) c.header("Retry-After", "60");
  c.header("X-Content-Type-Options", "nosniff");
  // A página do passo web leva o código no endereço: ela pede no-referrer.
  if (!c.res.headers.has("Referrer-Policy"))
    c.header("Referrer-Policy", "same-origin");
  if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
});
app.onError((error, c) => {
  const known = error instanceof ApiError;
  if (known && error.status === 429) c.header("Retry-After", "60");
  if (!known)
    console.error(
      JSON.stringify({
        request_id: c.get("requestId"),
        error: error instanceof SyntaxError ? "invalid_json" : "internal_error",
      }),
    );
  return c.json(
    {
      error: {
        code: known ? error.code : "internal_error",
        message: known
          ? error.message
          : "Não foi possível concluir a operação.",
        request_id: c.get("requestId"),
      },
    },
    (known ? error.status : 500) as any,
  );
});
app.get("/api/health", (c) =>
  c.json({
    service: "wabotia",
    ...buildInfo,
    runtime: "cloudflare-workers",
    // Código-fonte do commit em execução (AGPL-3.0, §13).
    source: sourceInfo(c.env),
    // Build de teste do atualizador: mostra o catálogo de onde ele lê.
    ...(RELEASE_ORIGIN !== OFFICIAL_RELEASE_ORIGIN
      ? { test_build: true, release_origin: RELEASE_ORIGIN }
      : {}),
  }),
);
// Só no build de teste do atualizador: o catálogo de teste vem do próprio R2
// (scripts/release-test-upload.mjs). No build oficial a rota não existe.
if (RELEASE_ORIGIN !== OFFICIAL_RELEASE_ORIGIN)
  app.get(`${TEST_CATALOG_PATH}/releases/*`, async (c) => {
    const path = c.req.path.slice(TEST_CATALOG_PATH.length + 1);
    if (!/^releases\/[a-zA-Z0-9._/-]+$/.test(path) || path.includes(".."))
      return c.notFound();
    const object = await c.env.MEDIA.get(`${TEST_CATALOG_PREFIX}/${path}`);
    if (!object) return c.notFound();
    return new Response(object.body, {
      headers: {
        "Content-Type":
          object.httpMetadata?.contentType || "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  });
app.get("/api/openapi.json", (c) => c.json(openapi(new URL(c.req.url).origin)));
app.use("/api/pairing/*", bodyLimit({ maxSize: 4096 }));
app.post("/api/pairing/start", async (c) =>
  c.json(
    await pairingStart(
      c.env,
      await c.req.json(),
      new URL(c.req.url).origin,
      c.req.header("CF-Connecting-IP") || "local",
    ),
    201,
  ),
);
app.post("/api/pairing/token", async (c) =>
  c.json(
    await pairingToken(
      c.env,
      await c.req.json(),
      c.req.header("CF-Connecting-IP") || "local",
    ),
  ),
);
// Instalador pelo navegador (docs/INSTALACAO.md). Só existe no site oficial.
// O corpo traz o token da pessoa: nunca é registrado nem guardado.
// Public queue pages: tracking by the ticket's token, TV panels by their token.
app.get("/api/public/queue/:token", async (c) => {
  await rate(
    c.env,
    "queue-public:" + (await sha(c.req.header("CF-Connecting-IP") || "")),
    120,
  );
  const owner = await one(
    c.env,
    "SELECT profile_id FROM queue_tickets WHERE public_token=?",
    c.req.param("token"),
  );
  if (owner) await requireModule(c.env, owner.profile_id, "queue");
  // Acompanhamento aberto pelo cliente: leva o código-fonte (AGPL-3.0, §13).
  return c.json({
    ...(await publicTicket(c.env, c.req.param("token"))),
    source: sourceInfo(c.env),
  });
});
// Credencial por QR (src/module-credentials.ts): o app sem login troca o
// código do QR por um token que só alcança as rotas do módulo. Uso único,
// limite por IP; a leitura e o gancho do módulo rodam no Coordinator da área.
app.post(
  "/api/credentials/claim",
  bodyLimit({ maxSize: 4 * 1024 }),
  async (c) => {
    const ip = c.req.header("CF-Connecting-IP") || "local";
    await rate(
      c.env,
      "credential-claim:" + (await ipHash(c.env, ip)),
      10,
      600000,
    );
    const body = await c.req.json<any>().catch(() => ({}));
    // A URL do QR (nova /api/public/c/ ou a antiga /c/, já impressa) ou só
    // o código.
    const code = String(body?.code ?? "")
      .trim()
      .replace(/^.*\/c\//, "");
    const owner = await claimOwner(c.env, code);
    if (!owner) throw new ApiError(404, "claim_not_found", "QR inválido.");
    return c.env.COORDINATOR.get(
      c.env.COORDINATOR.idFromName(owner.profile_id),
    ).fetch("https://coordinator/credential-claim", {
      method: "POST",
      body: JSON.stringify({
        profile: owner.profile_id,
        code,
        name: body?.name,
        device: body?.device,
        ip,
      }),
    });
  },
);
// O QR (https://<endereço público>/api/public/c/<código>; debaixo de /api/
// para o Worker responder antes dos arquivos do painel, run_worker_first do
// wrangler.jsonc) nunca é trocado aqui: prévias
// de link e a câmera comum não gastam o código. Com Accept: application/json,
// a leitura pública do app antes da troca ("Entrega da loja X, servidor Y —
// continuar?"): só o nome do estabelecimento e se o código vale; inexistente,
// vencido, lido ou revogado dão a mesma resposta (sem oráculo). Sem JSON, a
// página que orienta a abrir o app. Limite por IP nas duas.
const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=br.com.queven.wabotia";
app.get(`${CLAIM_PATH}:code`, async (c) => {
  const ip = c.req.header("CF-Connecting-IP") || "local";
  await rate(c.env, "credential-peek:" + (await ipHash(c.env, ip)), 30, 600000);
  const row = await peekClaim(c.env, c.req.param("code"));
  const live =
    row && (await moduleEnabled(c.env, row.profile_id, row.module_id))
      ? row
      : null;
  const store = live
    ? (await establishment(c.env, live.profile_id).catch(() => null))?.name ||
      null
    : null;
  const server = (await publicOrigin(c.env)) || new URL(c.req.url).origin;
  const headers = {
    "Cache-Control": "no-store",
    Vary: "Accept",
  };
  if ((c.req.header("Accept") || "").includes("application/json"))
    return c.json(
      live
        ? { valid: true, store, server, expires_at: live.claim_expires }
        : { valid: false, server },
      200,
      headers,
    );
  const links = [{ label: "Baixar na Google Play", href: PLAY_STORE_URL }];
  if (c.env.IOS_APP_URL?.startsWith("https://"))
    links.push({ label: "Baixar na App Store", href: c.env.IOS_APP_URL });
  return c.html(
    appInvitePage(appName(c.env), {
      app: appName(c.env),
      store,
      links,
    }),
    200,
    { ...webStepHeaders, ...headers },
  );
});
// Passo web (docs/MODULOS.md): página pública leve, aberta pelo link curto
// enviado no WhatsApp. O código do link é a credencial; só o hash é guardado.
const webStepHeaders = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
};
const webStepHtml = (c: any, body: string, status = 200) =>
  c.html(body, status, webStepHeaders);
const appName = (env: Env) => env.APP_NAME || "Wabotia";
// Páginas do passo web assinadas com os dados do estabelecimento da área.
const pageBrand = async (env: Env, profile: string) => ({
  app: appName(env),
  // Código-fonte do commit em execução no rodapé (AGPL-3.0, §13).
  source: sourceInfo(env).url,
  establishment: await establishment(env, profile).catch(() => null),
});
async function webStepRate(c: any) {
  await rate(
    c.env,
    "web-step:" + (await sha(c.req.header("CF-Connecting-IP") || "local")),
    120,
  );
}
async function webStepAvailable(env: Env, row: any) {
  return moduleById(row.module_id)
    ? moduleEnabled(env, row.profile_id, row.module_id)
    : true;
}
app.get("/api/w/:code", async (c) => {
  await webStepRate(c);
  const row = await webStepByCode(c.env, c.req.param("code"));
  if (!row) return webStepHtml(c, statePage("not_found", { app: appName(c.env), source: sourceInfo(c.env).url }), 404);
  const brand = await pageBrand(c.env, row.profile_id);
  const current = await touchWebStep(c.env, row);
  const conv = await one(
    c.env,
    "SELECT * FROM conversations WHERE id=?",
    row.conversation_id,
  );
  const whatsapp = conv ? await whatsappReturnLink(c.env, conv) : null;
  // Página de acompanhamento (spec.page "track"): o módulo diz o que mostrar.
  if (json(row.spec).page === "track") {
    const hook = webStepPageHook(row.module_id);
    const view =
      ["sent", "opened"].includes(current.status) &&
      hook &&
      (await webStepAvailable(c.env, row))
        ? await hook(c.env, row.profile_id, webStepView(current)).catch(
            (error: unknown) => {
              // O cliente vê "Acompanhamento encerrado"; o erro vai ao log.
              console.error(
                JSON.stringify({
                  component: "web-step-page",
                  module: row.module_id,
                  web_step: row.id,
                  error: String((error as Error)?.message || error).slice(
                    0,
                    300,
                  ),
                }),
              );
              return null;
            },
          )
        : null;
    if (!view)
      return webStepHtml(
        c,
        statePage("expired", brand, {
          whatsapp,
          title: "Acompanhamento encerrado",
          text: "Este acompanhamento não está mais disponível. Fale com a gente pelo WhatsApp.",
        }),
        410,
      );
    return webStepHtml(c, trackPage(view, brand, whatsapp));
  }
  if (current.status === "completed")
    return webStepHtml(c, statePage("used", brand, { whatsapp }));
  if (
    !["sent", "opened"].includes(current.status) ||
    !(await webStepAvailable(c.env, row))
  )
    return webStepHtml(
      c,
      statePage("expired", brand, {
        whatsapp,
        ...(current.status === "cancelled" ||
        ["sent", "opened"].includes(current.status)
          ? {
              title: "Link indisponível",
              text: "Este link não está mais disponível. Peça um novo na conversa pelo WhatsApp.",
            }
          : {}),
      }),
      410,
    );
  return webStepHtml(
    c,
    formPage({ ...current, public_code: c.req.param("code") }, brand),
  );
});
// Foto de item do carrinho enviada para a área (image_media_id): só as que o
// catálogo deste link cita, só imagem, enquanto o link existir.
app.get("/api/w/:code/img/:media", async (c) => {
  await webStepRate(c);
  const row = await webStepByCode(c.env, c.req.param("code"));
  const spec = row ? json(row.spec) : null;
  const id = c.req.param("media");
  // Só com o link aberto e o módulo ligado (revisão B3).
  if (
    !row ||
    spec?.page !== "cart" ||
    !catalogMedia(spec.cart).includes(id) ||
    !["sent", "opened"].includes(row.status) ||
    row.expires_at <= Date.now() ||
    !(await webStepAvailable(c.env, row))
  )
    throw new ApiError(404, "not_found", "Imagem não encontrada.");
  const media = await one(
    c.env,
    "SELECT * FROM media WHERE id=? AND profile_id=?",
    id,
    row.profile_id,
  );
  if (!media || !String(media.type).startsWith("image/"))
    throw new ApiError(404, "not_found", "Imagem não encontrada.");
  const response = await mediaResponse(c.env, media, c.req.raw);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Robots-Tag", "noindex");
  return new Response(response.body, { status: response.status, headers });
});
app.post("/api/w/:code", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
  await webStepRate(c);
  const origin = c.req.header("Origin");
  if (origin && origin !== "null" && origin !== new URL(c.req.url).origin)
    throw new ApiError(403, "invalid_origin", "Origem da requisição inválida.");
  const row = await webStepByCode(c.env, c.req.param("code"));
  if (!row) return webStepHtml(c, statePage("not_found", { app: appName(c.env), source: sourceInfo(c.env).url }), 404);
  // O código da URL, para as fotos da área na página (formPage).
  row.public_code = c.req.param("code");
  const brand = await pageBrand(c.env, row.profile_id);
  const spec = json(row.spec);
  // Acompanhamento só se lê.
  if (spec.page === "track")
    return webStepHtml(c, statePage("not_found", brand), 405);
  const form = await c.req.raw.formData().catch(() => new URLSearchParams());
  const cart = spec.page === "cart";
  const input = cart ? cartInput(form) : formInput(form);
  // Carrinho: montar e revisar não mudam nada; só "Confirmar pedido" conclui.
  if (cart && (input as Record<string, string[]>).confirm?.[0] !== "1") {
    const fields = input as Record<string, string[]>;
    if (row.status === "completed")
      return webStepHtml(c, statePage("used", brand), 410);
    if (
      !["sent", "opened"].includes(row.status) ||
      row.expires_at <= Date.now() ||
      !(await webStepAvailable(c.env, row))
    )
      return webStepHtml(
        c,
        statePage(
          "expired",
          brand,
          row.status === "cancelled"
            ? {
                title: "Link indisponível",
                text: "Este link não está mais disponível. Peça um novo na conversa pelo WhatsApp.",
              }
            : {},
        ),
        410,
      );
    if (fields.step?.[0] === "edit")
      return webStepHtml(c, formPage(row, brand, fields));
    if (fields.step?.[0]?.startsWith("add:"))
      return webStepHtml(
        c,
        formPage(
          row,
          brand,
          addCartSlot(spec.cart, fields, fields.step[0].slice(4)),
        ),
      );
    const checked = validateCartOrder(spec.cart, fields);
    return checked.ok
      ? webStepHtml(c, cartReviewPage(checked.order, spec, brand, fields))
      : webStepHtml(c, formPage(row, brand, fields, checked.errors), 422);
  }
  if (!(await webStepAvailable(c.env, row)))
    return webStepHtml(
      c,
      statePage("expired", brand, {
        title: "Link indisponível",
        text: "Este link não está mais disponível. Peça um novo na conversa pelo WhatsApp.",
      }),
      410,
    );
  const response = await c.env.COORDINATOR.get(
    c.env.COORDINATOR.idFromName(row.profile_id),
  ).fetch("https://coordinator/web-step", {
    method: "POST",
    body: JSON.stringify({
      profile: row.profile_id,
      id: row.id,
      answers: input,
    }),
  });
  const result = await response.json<any>();
  if (result.ok) {
    return webStepHtml(
      c,
      statePage("done", brand, {
        title: spec.title,
        text:
          spec.done_text ||
          (cart
            ? "Pedido enviado! A confirmação chega na conversa do WhatsApp."
            : "Recebemos suas respostas. A confirmação chega na conversa do WhatsApp."),
        whatsapp: result.whatsapp,
      }),
    );
  }
  if (result.reason === "invalid")
    return webStepHtml(
      c,
      formPage(row, brand, input, result.errors || {}),
      422,
    );
  // O módulo recusou agora (loja fechou, item esgotou): a mesma página com o
  // motivo, e o link continua aberto.
  if (result.reason === "rejected")
    return webStepHtml(
      c,
      formPage(row, brand, input, {
        [cart ? "cart" : "_form"]: result.message,
      }),
      409,
    );
  return webStepHtml(
    c,
    statePage(
      result.reason === "used"
        ? "used"
        : result.reason === "not_found"
          ? "not_found"
          : "expired",
      brand,
      {
        whatsapp: result.whatsapp,
        // Cancelado pela equipe ou pelo módulo: o mesmo aviso da abertura.
        ...(row.status === "cancelled"
          ? {
              title: "Link indisponível",
              text: "Este link não está mais disponível. Peça um novo na conversa pelo WhatsApp.",
            }
          : {}),
      },
    ),
    result.reason === "not_found" ? 404 : 410,
  );
});
// Prévia do link do cupom da senha (src/send-hint.ts), pública, sob /api/
// para o Worker responder em vez do fallback dos arquivos estáticos.
app.get(SEND_HINT_PATH, async (c) => {
  const origin = (await publicOrigin(c.env)) || new URL(c.req.url).origin;
  return c.html(sendHintPage(origin), 200, {
    "Cache-Control": "public, max-age=3600",
  });
});
const displayToken = (c: any) =>
  c.req.header("Authorization")?.match(/^Display ([0-9a-f]{64})$/)?.[1] ||
  c.req
    .header("Sec-WebSocket-Protocol")
    ?.split(",")
    .map((s: string) => s.trim())
    .find((s: string) => /^[0-9a-f]{64}$/.test(s));
app.get("/api/public/queue-display/state", async (c) => {
  const display = await displayByToken(c.env, displayToken(c));
  if (!display)
    throw new ApiError(401, "invalid_token", "Painel inválido ou revogado.");
  await requireModule(c.env, display.profile, "queue");
  return c.json({
    display: { id: display.id, name: display.name },
    ...(await queueOverview(c.env, display.profile, display.queue_ids)),
  });
});
app.get("/api/public/queue-display/ws", async (c) => {
  const display = await displayByToken(c.env, displayToken(c));
  if (!display)
    throw new ApiError(401, "invalid_token", "Painel inválido ou revogado.");
  await requireModule(c.env, display.profile, "queue");
  return queueSocket(c.env, c.req.raw, display.profile, display.queue_ids, [
    `display:${display.id}`,
  ]);
});
app.get("/api/install/status", (c) =>
  c.json({ enabled: webInstallerEnabled(c.env) }),
);
app.post("/api/install/step", bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
  if (!webInstallerEnabled(c.env))
    throw new ApiError(
      404,
      "not_found",
      "O instalador pelo navegador só existe no site oficial do Wabotia.",
    );
  if (c.req.header("Origin") !== new URL(c.req.url).origin)
    throw new ApiError(403, "invalid_origin", "Origem da requisição inválida.");
  await rate(
    c.env,
    "web-install:" + (await sha(c.req.header("CF-Connecting-IP") || "local")),
    400,
    600_000,
  );
  return c.json(await installStep(c.env, await c.req.json()));
});

app.get("/api/auth/status", async (c) => {
  const count = await one(c.env, "SELECT count(*) n FROM users");
  return c.json({
    initialized: count.n > 0,
    configured: !!c.env.MASTER_KEY && !!c.env.SETUP_TOKEN,
    // "Esqueci a senha" por e-mail (src/email.ts); sem ele, só o link do
    // administrador e a recuperação com o SETUP_TOKEN.
    email: count.n > 0 && (await emailReady(c.env)),
  });
});
app.use("/api/auth/*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (c.req.method === "POST" && origin && origin !== new URL(c.req.url).origin)
    throw new ApiError(403, "invalid_origin", "Origem inválida.");
  await next();
});
mountAccountPublic(app);
app.post("/api/auth/setup", async (c) => {
  await rate(
    c.env,
    `setup:${c.req.header("CF-Connecting-IP") || "local"}`,
    5,
    600000,
  );
  requireValue(
    c.env.SETUP_TOKEN && c.env.MASTER_KEY,
    "Configure SETUP_TOKEN e MASTER_KEY antes de continuar.",
  );
  const data = await c.req.json();
  if (!equal(data.token || "", c.env.SETUP_TOKEN))
    throw new ApiError(
      403,
      "invalid_setup_token",
      "Código de instalação inválido.",
    );
  if ((await one(c.env, "SELECT count(*) n FROM users")).n)
    throw new ApiError(
      409,
      "already_initialized",
      "Instalação já configurada.",
    );
  requireValue(
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email || ""),
    "E-mail inválido.",
  );
  const id = uid();
  await batch(c.env, [
    [
      "INSERT INTO receipts(scope,key,fingerprint,response,status,created) VALUES(?,?,?,?,?,?)",
      ["installation", "bootstrap", "bootstrap", "{}", 200, now()],
    ],
    [
      "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,?,?,?,?,?)",
      [
        id,
        String(data.email || "")
          .trim()
          .toLowerCase(),
        String(data.name || "Administrador").slice(0, 100),
        passwordHash(data.password),
        "admin",
        "[]",
        now(),
      ],
    ],
    installationAreaInsert(),
  ]);
  return c.json({ created: true }, 201);
});
app.post("/api/auth/login", async (c) => {
  await rate(
    c.env,
    `login:${c.req.header("CF-Connecting-IP") || "local"}`,
    10,
    600000,
  );
  const data = await c.req.json();
  const user = await one(
    c.env,
    "SELECT * FROM users WHERE email=? AND disabled=0",
    String(data.email || "").toLowerCase(),
  );
  if (!passwordMatches(String(data.password || ""), user?.password))
    throw new ApiError(
      401,
      "invalid_credentials",
      "E-mail ou senha inválidos.",
    );
  // Horário de acesso e segundo fator (src/mfa.ts).
  const aal = await loginSecondFactor(c.env, user, data);
  const token = random();
  await exec(
    c.env,
    "INSERT INTO sessions(hash,user_id,expires,kind,created,id,aal,mfa_at) VALUES(?,?,?,'cookie',?,?,?,?)",
    await sha(token),
    user.id,
    now() + 43200000,
    now(),
    uid(),
    aal,
    aal === 2 ? now() : null,
  );
  setCookie(c, "wabotia", token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/",
    maxAge: 43200,
  });
  return c.json({ ok: true, aal, mfa: await loginMfaNext(c.env, user, aal) });
});
const MOBILE_SESSION_MS = 30 * 86400000;
const mobilePlatforms = ["android", "ios"];
function mobileLabel(device: any) {
  return [device?.name, device?.app_version]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(" | ")
    .slice(0, 200);
}
async function createMobileSession(
  env: Env,
  userId: string,
  label: string,
  aal: 1 | 2 = 1,
  /** Horário do código na sessão anterior (renovação): o prazo não recomeça. */
  mfaAt: number | null = null,
) {
  const token = MOBILE_TOKEN_PREFIX + random(),
    expires = now() + MOBILE_SESSION_MS;
  await exec(
    env,
    "INSERT INTO sessions(hash,user_id,expires,kind,created,label,last_used,id,aal,mfa_at) VALUES(?,?,?,'bearer',?,?,?,?,?,?)",
    await sha(token),
    userId,
    expires,
    now(),
    label || null,
    now(),
    uid(),
    aal,
    aal === 2 ? (mfaAt ?? now()) : null,
  );
  return { token, expires, aal };
}
const mobileUser = (user: any) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  profiles: json(user.profiles, []),
});
app.post("/api/auth/mobile/login", async (c) => {
  await rate(
    c.env,
    `login:${c.req.header("CF-Connecting-IP") || "local"}`,
    10,
    600000,
  );
  const data = await c.req.json();
  requireValue(
    data.device &&
      typeof data.device === "object" &&
      mobilePlatforms.includes(data.device.platform),
    "Informe device.platform como android ou ios.",
  );
  const user = await one(
    c.env,
    "SELECT * FROM users WHERE email=? AND disabled=0",
    String(data.email || "")
      .trim()
      .toLowerCase(),
  );
  if (!passwordMatches(String(data.password || ""), user?.password))
    throw new ApiError(
      401,
      "invalid_credentials",
      "E-mail ou senha inválidos.",
    );
  const aal = await loginSecondFactor(c.env, user, data);
  const session = await createMobileSession(
    c.env,
    user.id,
    mobileLabel(data.device),
    aal,
  );
  return c.json({
    ...session,
    mfa: await loginMfaNext(c.env, user, aal),
    user: mobileUser(user),
  });
});
/** Área de uma rota /api/v1/profiles/:profile/…, ou null. */
function profileOfPath(path: string) {
  const [, , , segment, raw] = path.split("/");
  if (segment !== "profiles" || !raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
app.use("/api/v1/*", async (c, next) => {
  const internal = takeInternalActor(c.req.raw);
  // Uma ida só ao D1 antes da rota (docs/LIMITES.md): a credencial e, numa
  // rota de área, o estado dos módulos, que fica no cache de leituras desta
  // requisição. Leitura (GET) mantém o cache até o fim, e a rota reaproveita
  // o estado; escrita usa o cache só na conferência do módulo (a rota pode
  // passar pelo Coordinator, que grava fora deste env).
  const pre = withReadCache(c.env);
  if (["GET", "HEAD"].includes(c.req.method)) c.env = pre;
  c.set("pre", pre);
  const area = profileOfPath(c.req.path);
  const actor = internal ||
    await authenticate(
      pre,
      c.req.raw,
      area,
      // ERP: as pessoas da área com papel erp:* e as aplicações com escopo
      // do ERP vão no mesmo lote, para o envelope de identidade
      // (src/modules/erp/identity.ts).
      area && isErpPath(c.req.path)
        ? [
            [ERP_PEOPLE_SQL, [area]],
            [ERP_APPS_SQL, [area]],
          ]
        : [],
    );
  c.set("actor", actor);
  // Segundo fator exigido e sessão só com senha: só /me, o desafio e o
  // cadastro do fator (src/mfa.ts).
  if (!internal) mfaGate(actor, c.req.path);
  // Credencial por QR: só as rotas do módulo dela, na área dela.
  if (actor.credential) {
    const [, , , segment, profile, route] = c.req.path.split("/");
    const owner = route ? moduleForRoute(route) : null;
    if (
      segment !== "profiles" ||
      profile !== actor.profiles[0] ||
      owner?.id !== actor.credential.module
    )
      throw new ApiError(
        403,
        "credential_scope",
        "Este acesso vale só para a entrega do QR.",
      );
  }
  // Endereço público visto por quem usa o painel e os aplicativos: o passo
  // web monta com ele os links enviados ao cliente (src/web-steps.ts). Chaves
  // de integração podem chamar por outro domínio e não contam.
  if (!internal && actor.kind === "user")
    await rememberOrigin(c.env, c.req.url);
  await next();
});
// Rotas de um módulo desligado na área (/profiles/:profile/<rota do módulo>)
// respondem 409 module_disabled antes de qualquer outra regra.
app.use("/api/v1/profiles/*", async (c, next) => {
  const [, , , , raw, segment] = c.req.path.split("/");
  const owner = segment ? moduleForRoute(segment) : null;
  if (owner) {
    // Área de fora da credencial: 404 genérico antes de dizer se o módulo
    // está ligado; "%" malformado também é 404 (revisão B5).
    let profile: string;
    try {
      profile = decodeURIComponent(raw);
    } catch {
      throw new ApiError(
        404,
        "not_found",
        "Área de atendimento não encontrada.",
      );
    }
    if (!canProfile(c.get("actor"), profile))
      throw new ApiError(
        404,
        "not_found",
        "Área de atendimento não encontrada.",
      );
    // Estado dos módulos já lido junto com a credencial (authenticate).
    await requireModule(c.get("pre") ?? c.env, profile, owner.id);
  }
  await next();
});
// Ator interno restrito ao atendimento (conversations:bound): só as
// rotas da conversa que o bot está atendendo (a conferência da execução fica
// em conversation()) e catálogos sem dado pessoal. Nada de listas de
// conversas, contatos, protocolos, eventos ou relatórios da área.
const BOUND_ROUTES: [string, RegExp][] = [
  ["*", /^conversations\/[^/]+(\/.*)?$/],
  ["POST", /^(conversations|inbound|tickets)$/],
  ["PATCH", /^tickets\/[^/]+$/],
  ["GET", /^(bots|knowledge|forms)$/],
  [
    "GET",
    /^(agenda|agenda\/availability|reserva\/availability|pedido\/menu|pedido\/itens)$/,
  ],
  ["GET", /^(agenda|reserva|pedido|mensalidade|queue)\/conversations\/[^/]+$/],
  ["GET", /^suporte\/conversations\/[^/]+\/situation$/],
  ["GET", /^service-orders\/conversation\/[^/]+$/],
  ["GET", /^service-orders\/conversation\/[^/]+\/orders\/[^/]+$/],
  ["GET", /^service-orders\/conversation\/[^/]+\/orders\/[^/]+\/(tasks|documents|entries)$/],
];
app.use("/api/v1/profiles/*", async (c, next) => {
  if (isBound(c.get("actor"))) {
    const rest = c.req.path.split("/").slice(5).join("/");
    const method = c.req.method;
    if (
      !BOUND_ROUTES.some(
        ([m, pattern]) => (m === "*" || m === method) && pattern.test(rest),
      )
    )
      throw new ApiError(
        403,
        "bound_key",
        "Este bot atende só a conversa em que o bot está; listas e cadastros da área não estão disponíveis.",
      );
  }
  await next();
});
// Acesso por pessoa (src/access.ts): o atendente só alcança as rotas dos
// itens marcados no acesso dele (403 access_denied); rota fora do catálogo
// fica só para quem tem tudo. Os comandos conferem de novo em perform.
app.use("/api/v1/profiles/*", async (c, next) => {
  const segment = c.req.path.split("/")[5];
  const contribution = c.req.path.match(/\/contacts\/[^/]+\/modules\/([^/]+)\/(?:sections|collections)\/[^/]+$/);
  if (contribution) requireAccess(c.get("actor"), decodeURIComponent(contribution[1]));
  else if (segment) requireRouteAccess(c.get("actor"), ["contact-conflicts", "contact-identities", "contact-jobs"].includes(segment) ? "contacts" : segment);
  await next();
});
app.get("/api/v1/profiles/:profile/access", (c) => {
  // Catálogo para a tela de Pessoas e acessos: o que pode ser marcado nesta
  // área (módulos ligados) e os atalhos de perfil.
  if (!canProfile(c.get("actor"), c.req.param("profile")))
    throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  return moduleStates(c.env, c.req.param("profile")).then((states) => {
    const catalog = accessCatalog(states);
    return c.json({ data: catalog, presets: presetsFor(catalog) });
  });
});
// Conta: segundo fator, links de uso único (src/account-routes.ts).
mountAccount(app);
const mobileToken = (c: any) => {
  const bearer = c.req.header("Authorization")?.match(/^Bearer (.+)$/)?.[1];
  return bearer && bearer.startsWith(MOBILE_TOKEN_PREFIX) ? bearer : null;
};
app.get("/api/v1/me", (c) => c.json(c.get("actor")));
// Versão do servidor e módulos ligados por área (docs/MODULOS.md). Vale para
// pessoas e para chaves de aplicação, inclusive aparelhos pareados.
app.get("/api/v1/capabilities", async (c) =>
  c.json(
    await serverCapabilities(
      c.env,
      c.get("actor"),
      c.req.query("profile") || c.req.query("profile_id") || null,
    ),
  ),
);
// Mesma resposta para uma área, com `modules` também no topo: é o primeiro
// caminho que o app Android consulta.
app.get("/api/v1/profiles/:profile/capabilities", async (c) => {
  const result = await serverCapabilities(
    c.env,
    c.get("actor"),
    c.req.param("profile"),
  );
  return c.json({ ...result, modules: result.profiles[0].modules });
});
// Dados do estabelecimento (cupom, comanda, recibo): pessoa com acesso à área
// ou chave de aplicação dela, inclusive aparelho pareado, sem escopo próprio.
app.get("/api/v1/profiles/:profile/establishment", async (c) => {
  const profile = c.req.param("profile");
  if (!canProfile(c.get("actor"), profile))
    throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  return c.json(await establishment(c.env, profile));
});
// ERP (Fagoo) pela erp-api original e o motor no objeto erp:<área>
// (src/erp/api/local-fetch.ts; fase 0, docs/ERP-FASE0.md).
app.all("/api/v1/profiles/:profile/erp/*", async (c) => {
  const profile = c.req.param("profile");
  if (!canProfile(c.get("actor"), profile))
    throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  // Envelope de identidade montado pelo núcleo (papel, sessão, fator e as
  // pessoas da área, já lidas no lote antes da rota).
  const identity = await erpIdentity(
    c.get("pre") ?? c.env,
    c.get("actor"),
    profile,
    c.req.method,
  );
  return erpApi(c.env, c.req.raw, profile, c.get("actor"), identity);
});
// Emissor fiscal do ERP (cliente do cofre NFapi; src/erp/emissor/README.md):
// pessoa da área, módulos erp e erp-fiscal ligados (409 module_disabled),
// escrita só de administrador. Fora de /erp/*, que é a erp-api do Fagoo.
// Import dinâmico: o cliente e o contrato só carregam no primeiro uso.
const erpEmissor = async (c: any) => {
  const profile = c.req.param("profile");
  if (!canProfile(c.get("actor"), profile))
    throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const { erpEmissorRoute } = await import("./erp/emissor/routes");
  return erpEmissorRoute(c.env, c.req.raw, profile, c.get("actor"));
};
app.all("/api/v1/profiles/:profile/erp-emissor", erpEmissor);
app.all("/api/v1/profiles/:profile/erp-emissor/*", erpEmissor);
// Relatórios e exportação pelo cofre (Fiscal, F6b; src/erp/fiscal-cofre/README.md):
// papel fiscal ou administrador; os links de download vão ao navegador.
app.all("/api/v1/profiles/:profile/erp-fiscal-cofre/*", async (c: any) => {
  const profile = c.req.param("profile");
  if (!canProfile(c.get("actor"), profile))
    throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const { erpFiscalVaultRoute } = await import("./erp/fiscal-cofre/routes");
  return erpFiscalVaultRoute(c.env, c.req.raw, profile, c.get("actor"));
});
// Arquivo do ERP por URL assinada de curta duração (a exportação da empresa):
// sem sessão, o token (HMAC) vale para um objeto de uma área até vencer
// (src/erp-storage.ts). Os buckets do ERP nunca são públicos.
app.get("/api/public/erp-storage/*", (c) =>
  erpSignedDownload(c.env, c.req.raw),
);
// Sondas do ERP para a instalação de teste (só com ERP_PROBES=1 no deploy).
app.post("/api/v1/profiles/:profile/erp-probe/:name", async (c) => {
  const profile = c.req.param("profile");
  if (!canProfile(c.get("actor"), profile))
    throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  return erpProbe(
    c.env,
    c.req.raw,
    profile,
    c.get("actor"),
    c.req.param("name"),
  );
});
// Static catalogue, previewed in the panel before an administrator applies it.
app.get("/api/v1/service-templates", (c) => {
  if (c.get("actor").kind !== "user")
    throw new ApiError(
      403,
      "user_required",
      "Os modelos de central são consultados por pessoas autenticadas.",
    );
  return c.json({ data: listServiceTemplates() });
});
app.post("/api/v1/installation/area/bootstrap", async (c) =>
  c.json(
    await ensureInstallationArea(c.env, c.get("actor"), c.get("requestId")),
  ),
);
app.get("/api/v1/pairings", async (c) =>
  c.json(await pairingList(c.env, c.get("actor"))),
);
app.post("/api/v1/pairings/disconnect", async (c) => {
  const actor = c.get("actor");
  const result = await pairingDisconnect(c.env, actor);
  // O próprio aparelho desfez o pareamento: os sockets dele fecham já.
  await closeSockets(
    c.env,
    actor.profiles,
    await credentialTags(c.req.raw, actor),
  );
  return c.json(result);
});
app.post("/api/v1/pairings/lookup", async (c) =>
  c.json(
    await pairingLookup(c.env, c.get("actor"), (await c.req.json()).user_code),
  ),
);
app.post("/api/v1/pairings/:id/approve", async (c) =>
  c.json(
    await pairingApprove(
      c.env,
      c.get("actor"),
      c.req.param("id"),
      await c.req.json(),
    ),
  ),
);
app.post("/api/v1/pairings/:id/deny", async (c) =>
  c.json(await pairingDeny(c.env, c.get("actor"), c.req.param("id"))),
);
app.delete("/api/v1/pairings/:id", async (c) => {
  const pairing = await one(
    c.env,
    "SELECT app_id FROM pairing_requests WHERE id=?",
    c.req.param("id"),
  );
  const result = await pairingRevoke(c.env, c.get("actor"), c.req.param("id"));
  if (pairing?.app_id)
    await closeSockets(c.env, await appProfiles(c.env, pairing.app_id), [
      `app:${pairing.app_id}`,
    ]);
  return c.json(result);
});
app.post("/api/v1/auth/mobile/refresh", async (c) => {
  const token = mobileToken(c);
  if (!token || c.get("actor").kind !== "user")
    throw new ApiError(
      400,
      "invalid_request",
      "A renovação exige uma sessão móvel (Bearer wabu_).",
    );
  const hash = await sha(token);
  const old = await one(
    c.env,
    "SELECT label,mfa_at FROM sessions WHERE hash=? AND kind='bearer'",
    hash,
  );
  const user = await one(
    c.env,
    "SELECT * FROM users WHERE id=?",
    c.get("actor").id,
  );
  // A sessão nova mantém o nível e o horário do código da antiga: o prazo
  // da confirmação não recomeça na renovação (src/mfa.ts).
  const session = await createMobileSession(
    c.env,
    c.get("actor").id,
    old?.label || "",
    c.get("actor").aal === 2 ? 2 : 1,
    old?.mfa_at ?? null,
  );
  await exec(c.env, "DELETE FROM sessions WHERE hash=?", hash);
  return c.json({ ...session, user: mobileUser(user) });
});
app.post("/api/v1/logout", async (c) => {
  // Sockets desta sessão (não os de outros aparelhos da mesma pessoa).
  const actor = c.get("actor");
  if (actor.kind === "user")
    await closeSockets(
      c.env,
      await userProfiles(c.env, actor.id),
      (await credentialTags(c.req.raw, actor)).filter((t) =>
        t.startsWith("session:"),
      ),
    );
  const cookie = c.req.header("Cookie")?.match(/wabotia=([^;]+)/)?.[1];
  if (cookie)
    await exec(c.env, "DELETE FROM sessions WHERE hash=?", await sha(cookie));
  const bearer = mobileToken(c);
  if (bearer)
    await exec(c.env, "DELETE FROM sessions WHERE hash=?", await sha(bearer));
  deleteCookie(c, "wabotia", { path: "/" });
  return c.json({ ok: true });
});
function requireUser(actor: Actor) {
  if (actor.kind !== "user")
    throw new ApiError(
      403,
      "user_required",
      "Dispositivos pertencem a contas de atendente.",
    );
}
const deviceView = (d: any) => ({ ...d, profiles: json(d.profiles, []) });
app.get("/api/v1/devices", async (c) => {
  const actor = c.get("actor");
  requireUser(actor);
  return c.json({
    data: (
      await all(
        c.env,
        "SELECT * FROM devices WHERE user_id=? ORDER BY created",
        actor.id,
      )
    ).map(deviceView),
  });
});
app.put("/api/v1/devices/:id", async (c) => {
  const actor = c.get("actor"),
    id = c.req.param("id");
  requireUser(actor);
  requireValue(
    /^[A-Za-z0-9_-]{8,100}$/.test(id),
    "Identificador do dispositivo inválido.",
  );
  const data = await c.req.json();
  requireValue(
    mobilePlatforms.includes(data.platform),
    "Informe platform como android ou ios.",
  );
  const provider = data.provider ?? "fcm";
  requireValue(provider === "fcm", "Provedor de push não suportado.");
  requireValue(
    typeof data.token === "string" &&
      data.token.trim().length > 0 &&
      data.token.length <= 4096,
    "Informe o token do provedor (até 4096 caracteres).",
  );
  const profiles = data.profiles ?? [];
  requireValue(
    Array.isArray(profiles) &&
      profiles.length <= 50 &&
      profiles.every(
        (p: any) => typeof p === "string" && p.length > 0 && p.length <= 100,
      ),
    "profiles deve ser uma lista de até 50 identificadores.",
  );
  const token = data.token.trim(),
    origin = new URL(c.req.url).origin;
  await rate(c.env, `devices:${actor.id}`, 30);
  // Taking over another person's device id needs proof of possession: the
  // same provider token (another person signing in on the same handset).
  const existing = await one(
    c.env,
    "SELECT user_id,provider,token FROM devices WHERE id=?",
    id,
  );
  if (
    existing &&
    existing.user_id !== actor.id &&
    !(existing.provider === provider && existing.token === token)
  )
    throw new ApiError(
      409,
      "device_conflict",
      "Este identificador de dispositivo pertence a outra pessoa.",
    );
  await batch(c.env, [
    [
      "DELETE FROM devices WHERE provider=? AND token=? AND id!=?",
      [provider, token, id],
    ],
    [
      "INSERT INTO devices(id,user_id,platform,provider,token,name,app_version,profiles,origin,enabled,last_error,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,platform=excluded.platform,provider=excluded.provider,token=excluded.token,name=excluded.name,app_version=excluded.app_version,profiles=excluded.profiles,origin=excluded.origin,enabled=excluded.enabled,last_error=NULL,updated=excluded.updated",
      [
        id,
        actor.id,
        data.platform,
        provider,
        token,
        String(data.name || "").slice(0, 100),
        String(data.app_version || "").slice(0, 50),
        JSON.stringify(profiles),
        origin,
        data.enabled === undefined || data.enabled ? 1 : 0,
        now(),
        now(),
      ],
    ],
    // At most MAX_DEVICES_PER_USER rows per person: the oldest are dropped.
    [
      "DELETE FROM devices WHERE user_id=? AND id NOT IN (SELECT id FROM devices WHERE user_id=? ORDER BY updated DESC,created DESC,id DESC LIMIT ?)",
      [actor.id, actor.id, MAX_DEVICES_PER_USER],
    ],
  ]);
  return c.json(
    deviceView(await one(c.env, "SELECT * FROM devices WHERE id=?", id)),
  );
});
app.delete("/api/v1/devices/:id", async (c) => {
  const actor = c.get("actor");
  requireUser(actor);
  const result = await exec(
    c.env,
    "DELETE FROM devices WHERE id=? AND user_id=?",
    c.req.param("id"),
    actor.id,
  );
  return c.json({ deleted: (result.meta?.changes || 0) > 0 });
});
app.post("/api/v1/devices/:id/test", async (c) => {
  const actor = c.get("actor");
  requireUser(actor);
  await rate(c.env, `push-test:${actor.id}`, 5);
  const device = await one(
    c.env,
    "SELECT * FROM devices WHERE id=? AND user_id=?",
    c.req.param("id"),
    actor.id,
  );
  if (!device)
    throw new ApiError(404, "not_found", "Dispositivo não encontrado.");
  return c.json({ results: await sendTest(c.env, [device]) });
});
app.get("/api/v1/profiles", async (c) =>
  c.json(
    (await all(c.env, "SELECT * FROM profiles ORDER BY created"))
      .filter((p) => canProfile(c.get("actor"), p.id))
      .map((p) =>
        c.get("actor").kind === "app"
          ? { id: p.id, name: p.name, enabled: p.enabled }
          : { ...p, settings: json(p.settings) },
      ),
  ),
);
app.get("/api/v1/users", async (c) => {
  admin(c.get("actor"));
  return c.json(
    await all(
      c.env,
      "SELECT id,email,name,role,profiles,disabled,access,schedule,password='' invite_pending,EXISTS(SELECT 1 FROM user_factors f WHERE f.user_id=users.id AND f.status='active') has_mfa FROM users ORDER BY created",
    ),
  );
});
app.get("/api/v1/applications", async (c) => {
  admin(c.get("actor"));
  return c.json({
    applications: await all(c.env, "SELECT * FROM applications ORDER BY created DESC"),
    keys: await all(
      c.env,
      "SELECT id,app_id,prefix,expires,revoked,created FROM api_keys",
    ),
    scopes,
    event_types: eventTypes,
  });
});
/**
 * Credencial que uma operação de administração derruba: chave revogada,
 * aplicação desativada ou retirada de áreas, pessoa alterada (as sessões dela
 * são apagadas). Os sockets dela fecham depois do sucesso.
 */
async function revocationTargets(
  env: Env,
  op: string,
  id: string | undefined,
  data: any,
): Promise<{ profiles: string[]; tags: string[] } | null> {
  if (!id) return null;
  if (op === "key.revoke") {
    const key = await one(env, "SELECT app_id FROM api_keys WHERE id=?", id);
    return key
      ? { profiles: await appProfiles(env, key.app_id), tags: [`key:${id}`] }
      : null;
  }
  if (op === "application.update") {
    const before = await appProfiles(env, id);
    // Permissão retirada (revisão B4): fecha os sockets da aplicação em todas
    // as áreas; o cliente reconecta com as permissões novas.
    const app = await one(
      env,
      "SELECT scopes FROM applications WHERE id=?",
      id,
    );
    const scopesBefore: string[] = json(app?.scopes, []);
    const reduced =
      Array.isArray(data?.scopes) &&
      scopesBefore.some((scope) => !data.scopes.includes(scope));
    const removed =
      data?.disabled === true || reduced
        ? before
        : Array.isArray(data?.profiles)
          ? before.filter((p) => !data.profiles.includes(p))
          : [];
    return removed.length ? { profiles: removed, tags: [`app:${id}`] } : null;
  }
  if (op === "user.update")
    return { profiles: await userProfiles(env, id), tags: [`user:${id}`] };
  return null;
}

async function mutate(c: any, op: string, profile: string, data: any) {
  const key = c.req.header("Idempotency-Key");
  requireValue(
    key && key.length <= 200 && /^[\x21-\x7e]+$/.test(key),
    "Envie Idempotency-Key (até 200 caracteres ASCII).",
  );
  if (profile !== "_admin" && !canProfile(c.get("actor"), profile))
    throw new ApiError(404, "not_found", "Perfil não encontrado.");
  const response = await c.env.COORDINATOR.get(c.env.COORDINATOR.idFromName(profile)).fetch(
    "https://coordinator/command",
    {
      method: "POST",
      body: JSON.stringify({
        profile,
        operation: op,
        actor: c.get("actor"),
        data,
        key,
        requestId: c.get("requestId"),
      }),
    },
  );
  if (op.startsWith("contact.") && response.status === 409) {
    const error = await response.clone().json();
    if (error?.error?.code === "operation_unknown") {
      const recovered = await recoverContactCommand(c.env, c.get("actor"), profile, op, key);
      if (recovered) return Response.json(recovered, { headers: { "Idempotency-Replayed": "true", "Cache-Control": "no-store" } });
    }
  }
  return response;
}
app.get("/api/v1/system", async (c) => {
  admin(c.get("actor"));
  return c.json({
    updates: await updateStatus(c.env),
    // Endereço dos links enviados aos clientes (src/web-steps.ts).
    public_origin: await publicOrigin(c.env),
    // Bot da conversa interna: dado pessoal completo nas consultas (src/bot-actions).
    bot_full_personal_data: await fullPersonalData(c.env),
  });
});
// Liberar dado pessoal completo nas consultas do bot da conversa interna: os
// dados vão ao provedor de IA. Só administrador; desligado de fábrica.
app.post("/api/v1/system/bot-actions/configure", async (c) => {
  admin(c.get("actor"));
  const data = await c.req.json<any>().catch(() => ({}));
  requireValue(
    typeof data?.full_personal_data === "boolean",
    "Informe full_personal_data como verdadeiro ou falso.",
  );
  await setFullPersonalData(c.env, data.full_personal_data);
  return c.json({ bot_full_personal_data: data.full_personal_data });
});
app.get("/api/v1/system/updates/check", async (c) => {
  admin(c.get("actor"));
  await rate(c.env, `updates:${c.get("actor").id}`, 5);
  await checkUpdate(c.env);
  return c.json(await updateStatus(c.env));
});
app.get("/api/v1/system/push", async (c) => {
  admin(c.get("actor"));
  return c.json({
    ...publicPushConfig(await pushConfig(c.env)),
    devices: (
      await one(c.env, "SELECT count(*) n FROM devices WHERE enabled=1")
    )?.n,
  });
});
app.post("/api/v1/system/push/test", async (c) => {
  admin(c.get("actor"));
  await rate(c.env, `push-test:${c.get("actor").id}`, 5);
  const devices = await all(
    c.env,
    "SELECT * FROM devices WHERE user_id=? AND enabled=1",
    c.get("actor").id,
  );
  requireValue(
    devices.length > 0,
    "Nenhum dispositivo ativo registrado para a sua conta. Entre no aplicativo antes de testar.",
  );
  return c.json({ results: await sendTest(c.env, devices) });
});
for (const [path, operation] of [
  ["updates/configure", "updates.configure"],
  ["updates/automatic", "updates.automatic"],
  ["updates/initial-token/delete", "updates.delete_initial_token"],
  ["updates/token-mode", "updates.token_mode"],
  ["updates/start", "updates.start"],
  ["updates/reset", "updates.reset"],
  ["push/configure", "push.configure"],
  ["origin/configure", "origin.save"],
  ["email/configure", "email.configure"],
])
  app.post("/api/v1/system/" + path, async (c) => {
    admin(c.get("actor"));
    return mutate(c, "system." + operation, "_admin", await c.req.json());
  });
for (const [method, path, op] of [
  ["post", "profiles", "profile.create"],
  ["post", "users", "user.create"],
  ["post", "users/invite", "user.invite"],
  ["patch", "users/:id", "user.update"],
  ["post", "applications", "application.create"],
  ["patch", "applications/:id", "application.update"],
  ["post", "applications/:id/keys", "key.create"],
  ["delete", "keys/:id", "key.revoke"],
] as const) {
  app.on(method.toUpperCase(), `/api/v1/${path}`, async (c) => {
    admin(c.get("actor"));
    const data = method === "delete" ? {} : await c.req.json();
    const id = c.req.param("id");
    // Antes de mudar: onde estão os sockets que a revogação vai fechar.
    const revoked = await revocationTargets(c.env, op, id, data);
    const response = await mutate(c, op, "_admin", {
      ...data,
      id,
      ...(op === "key.create" ? { app_id: id } : {}),
    });
    if (response.ok && revoked)
      await closeSockets(c.env, revoked.profiles, revoked.tags);
    return response;
  });
}
// Modelos da conta de um provedor de IA, para o formulário da conexão. Fica
// fora dos comandos idempotentes: a resposta não deve ir para os recibos, e a
// chave digitada no formulário passa só por aqui, sem ser guardada.
app.post("/api/v1/profiles/:profile/ai-models", async (c) => {
  const actor = c.get("actor"),
    profile = c.req.param("profile");
  admin(actor);
  await rate(c.env, `ai-models:${actor.id}`, 10);
  const body = await c.req.json<any>().catch(() => ({}));
  let cfg: any = {},
    key = typeof body.api_key === "string" ? body.api_key.trim() : "";
  if (body.connection_id) {
    const conn = await one(
      c.env,
      "SELECT * FROM connections WHERE id=? AND profile_id=? AND kind='ai'",
      String(body.connection_id),
      profile,
    );
    requireValue(conn, "Conexão não encontrada.");
    cfg = json(conn.config);
    if (!key) key = (await secret(c.env, `connection:${conn.id}`)).api_key;
  }
  requireValue(key, "Informe a chave de API para buscar os modelos.");
  return c.json({
    data: await aiListModels(
      body.provider || cfg.provider,
      key,
      body.base_url || cfg.base_url,
    ),
  });
});
// A retired authorization URL must never be replayed from Coordinator receipts.
// The local handler still enforces administrator and integration-area access.
app.post("/api/v1/profiles/:profile/router/accounts/:id/connect", async (c) =>
  c.json(
    await zernioAccountCommand(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      "zernio-account.connect",
      { id: c.req.param("id") },
    ),
  ),
);
app.put("/api/v1/profiles/:profile/router/numbers/:id/limit", async (c) =>
  c.json(
    await routerCommand(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      "router.number.limit",
      { id: c.req.param("id") },
      "",
    ),
  ),
);
const commands = [
  ["PUT", "lines/:id", "line.save"],
  ["POST", "internal-chats", "internal.create"],
  ["POST", "internal-chats/:id/messages", "internal.send"],
  ["POST", "router/accounts", "zernio-account.save"],
  ["DELETE", "router/accounts/:id", "integration.delete"],
  ["POST", "router/accounts/:id/discover", "zernio-account.discover"],
  ["POST", "router/accounts/:id/resolve", "zernio-account.resolve"],
  ["POST", "router/numbers", "zernio-number.save"],
  ["PUT", "router/numbers/:id/policy", "router.number.policy"],
  ["POST", "router/pools", "router.pool.save"],
  ["PUT", "router/grants", "router.grants.save"],
  ["POST", "router/messages", "router.send"],
  ["POST", "router/messages/:id/cancel", "router.cancel"],
  ["PUT", "settings", "settings"],
  ["POST", "service-templates/:id/apply", "service-template.apply"],
  ["POST", "activate", "activate"],
  ["POST", "pause", "pause"],
  ["POST", "connections", "connection.save"],
  ["PUT", "connections/:id/state", "connection.state"],
  ["DELETE", "connections/:id", "connection.delete"],
  ["PATCH", "bots/:id", "bot.update"],
  ["POST", "conversations", "conversation.create"],
  ["POST", "inbound", "inbound"],
  ["POST", "media/uploads", "upload.create"],
  ["POST", "media/uploads/:id/complete", "upload.complete"],
  ["POST", "media/uploads/:id/abort", "upload.abort"],
  ["POST", "conversations/:id/message-actions", "message.action"],
  ["POST", "groups/actions", "group.action"],
  ["POST", "group-operations/:id/reconcile", "group.reconcile"],
  ["POST", "groups/:id/actions", "group.action"],
  ["PUT", "groups/:id/policy", "group.policy"],
  ["POST", "calls", "call.start"],
  ["POST", "calls/permission", "call.permission"],
  ["POST", "calls/:id/claim", "call.claim"],
  ["POST", "calls/:id/pre_accept", "call.pre_accept"],
  ["POST", "calls/:id/accept", "call.accept"],
  ["POST", "calls/:id/reject", "call.reject"],
  ["POST", "calls/:id/terminate", "call.terminate"],
  ["POST", "calls/:id/keepalive", "call.keepalive"],
  ["POST", "calls/:id/reconcile", "call.reconcile"],
  ["PUT", "connections/:id/calling", "call.configure"],
  ["POST", "conversations/:id/actions", "conversation.action"],
  ["POST", "contacts", "contact.create"],
  ["PATCH", "contacts/:id", "contact.update"],
  ["POST", "contacts/import", "contact.import"],
  ["POST", "contacts/:id/promote", "contact.promote"],
  ["POST", "contacts/from-erp", "contact.from-erp"],
  ["POST", "contact-identities/resolve", "contact.resolve-phone"],
  ["POST", "contacts/:id/erasure", "contact.erasure"],
  ["PUT", "contacts/:id/modules/:module/sections/:section", "contact.section"],
  ["PUT", "conversations/:id/contact", "contact.from-conversation"],
  ["DELETE", "conversations/:id/contact", "contact.unlink"],
  ["PUT", "presence", "presence"],
  ["POST", "tickets", "ticket.create"],
  ["PATCH", "tickets/:id", "ticket.update"],
  ["POST", "consents/request", "consent.request"],
  ["POST", "bot-runs", "run.create"],
  ["POST", "bot-runs/:id/cancel", "run.cancel"],
  ["POST", "knowledge", "knowledge.create"],
  ["PATCH", "knowledge/:id", "knowledge.update"],
  ["DELETE", "knowledge/:id", "knowledge.delete"],
  ["POST", "webhook-subscriptions", "webhook.create"],
  ["DELETE", "webhook-subscriptions/:id", "webhook.disable"],
  ["POST", "webhook-deliveries/:id/retry", "webhook.retry"],
  ["POST", "deliveries/:id/reconcile", "delivery.reconcile"],
  // Fila de senhas (docs/FILA-SENHAS.md).
  ["POST", "queue/queues", "queue.save"],
  ["PUT", "queue/queues/:id", "queue.save"],
  ["POST", "queue/counters", "counter.save"],
  ["PUT", "queue/counters/:id", "counter.save"],
  ["POST", "queue/counters/:id/state", "counter.state"],
  ["POST", "queue/counters/:id/call-next", "queue.call_next"],
  ["POST", "queue/tickets", "queue.issue"],
  ["POST", "queue/tickets/:id/recall", "queue.recall"],
  ["POST", "queue/tickets/:id/start", "queue.start"],
  ["POST", "queue/tickets/:id/finish", "queue.finish"],
  ["POST", "queue/tickets/:id/no-show", "queue.no_show"],
  ["POST", "queue/tickets/:id/cancel", "queue.cancel"],
  ["POST", "queue/tickets/:id/transfer", "queue.transfer"],
  ["POST", "queue/blocklist", "queue.block"],
  ["DELETE", "queue/blocklist/:id", "queue.unblock"],
  ["POST", "queue/displays", "queue.display.create"],
  ["DELETE", "queue/displays/:id", "queue.display.revoke"],
  // Módulos embutidos (docs/MODULOS.md).
  ["PUT", "modules/:id", "module.set"],
  ["POST", "web-steps/:id/cancel", "web_step.cancel"],
];
for (const [method, path, op] of commands)
  app.on(method, `/api/v1/profiles/:profile/${path}`, async (c) => {
    const profile = c.req.param("profile")!;
    const commandOperation = op === "contact.section" ? `${c.req.param("module")}.customer-section` : op;
    const response = await mutate(c, commandOperation, profile, {
      ...(method === "DELETE" && op !== "contact.unlink"
        ? {}
        : await c.req.json().catch(() => ({}))),
      ...(c.req.param("id") ? { id: c.req.param("id") } : {}),
      ...(op === "contact.section" ? { module: c.req.param("module"), section: c.req.param("section") } : {}),
    });
    // Painel de TV revogado: a tela cai na hora.
    if (op === "queue.display.revoke" && response.ok)
      await closeSockets(c.env, [profile], [`display:${c.req.param("id")}`]);
    return op.startsWith("contact.") ? customerResponse(response, op) : response;
  });
// Telemetria dos módulos (onTelemetry): POST sem Idempotency-Key e fora do
// Coordinator, para posições em lote; corpo até 64 KB, até TELEMETRY_RATE
// chamadas por minuto por credencial, área e rota.
const TELEMETRY_RATE = 60;
for (const route of moduleRoutes().telemetry)
  app.post(
    `/api/v1/profiles/:profile/${route.path}`,
    bodyLimit({ maxSize: 64 * 1024 }),
    async (c) => {
      const profile = c.req.param("profile")!;
      const actor = c.get("actor");
      if (!canProfile(actor, profile))
        throw new ApiError(404, "not_found", "Perfil não encontrado.");
      credentialGate(actor, route, c.req.param() as Record<string, string>);
      // Conectores não mandam telemetria; a escrita mais barata da API tem
      // limite por credencial e rota no núcleo (revisão A).
      if (actor.kind === "connector")
        throw new ApiError(
          403,
          "forbidden",
          "Conectores não enviam dados para esta rota.",
        );
      await rate(
        c.env,
        `telemetry:${actor.keyId || actor.id}:${profile}:${route.path}`,
        TELEMETRY_RATE,
      );
      const body = await c.req.json().catch(() => null);
      requireValue(
        body && typeof body === "object" && !Array.isArray(body),
        "Envie um objeto JSON.",
      );
      return c.json(
        await route.handler(c.env, c.get("actor"), profile, {
          params: c.req.param() as Record<string, string>,
          body,
        }),
      );
    },
  );
// Consulta o registro atual, inclusive extensões carregadas depois desta
// entrada. Mantém os gates anteriores e deixa rotas do núcleo prosseguirem.
app.use("/api/v1/profiles/:profile/*", async (c, next) => {
  const match = matchModuleRoute(c.req.method, c.req.path);
  if (!match) return next();
  const { route, params } = match;
  const profile = params.profile;
  const actor = c.get("actor");
  // Credencial por QR: negada por padrão, salvo declaração e ID do registro.
  if (route.kind === "write") {
    credentialGate(actor, route, params);
    return mutate(c, route.op, profile, routeData(
      route.method === "DELETE" ? {} : await c.req.json().catch(() => ({})),
      params,
    ));
  }
  if (!canProfile(actor, profile))
    throw new ApiError(404, "not_found", "Perfil não encontrado.");
  credentialGate(actor, route, params);
  // Sem c.json: bytes permanecem intactos; metadados passam pelo Coordinator.
  if (route.kind === "binary")
    return route.handler(c.env, actor, profile, {
      params, query: c.req.query(), request: c.req.raw,
    });
  return c.json(await route.handler(c.env, actor, profile, {
    params, query: c.req.query(),
  }));
});
// Uma fonte do Conhecimento com o texto completo, para edição no painel.
app.get("/api/v1/profiles/:profile/knowledge/:id", async (c) => {
  const profile = c.req.param("profile");
  access(c.get("actor"), profile, "knowledge:read");
  const doc = await one(
    c.env,
    "SELECT * FROM documents WHERE id=? AND profile_id=?",
    c.req.param("id"),
    profile,
  );
  if (!doc) throw new ApiError(404, "not_found", "Fonte não encontrada.");
  return c.json({
    ...doc,
    text: await documentText(c.env, profile, doc.id),
  });
});
app.post("/api/v1/bot-runs", async (c) => {
  const data = await c.req.json();
  requireValue(typeof data.profile_id === "string", "Informe profile_id.");
  return mutate(c, "run.create", data.profile_id, data);
});
app.get("/api/v1/bot-runs/:id", async (c) => {
  const run = await one(
    c.env,
    "SELECT * FROM bot_runs WHERE id=?",
    c.req.param("id"),
  );
  if (!run) throw new ApiError(404, "not_found", "Execução não encontrada.");
  access(c.get("actor"), run.profile_id, "bots:invoke");
  // Runs asked directly to a bot (no customer conversation) belong to whoever
  // asked; only an administrator may read someone else's.
  const viewer = c.get("actor"),
    direct = !run.conversation_id && !json(run.context).internal_chat_id;
  if (
    run.actor !== viewer.id &&
    (viewer.kind === "app" ||
      json(run.context).internal_chat_id ||
      (direct && viewer.role !== "admin"))
  )
    throw new ApiError(404, "not_found", "Execução não encontrada.");
  run.attachments = json(run.result, {}).attachments || [];
  run.input = runQuestion(run);
  delete run.context;
  delete run.request_body;
  return c.json(run);
});
app.use("/api/v1/profiles/:profile/*", async (c, next) => {
  if (!canProfile(c.get("actor"), c.req.param("profile")!))
    throw new ApiError(404, "not_found", "Perfil não encontrado.");
  await next();
});
app.get("/api/v1/profiles/:profile/status", async (c) => {
  const p = c.req.param("profile");
  if (c.get("actor").kind === "app")
    throw new ApiError(
      403,
      "panel_only",
      "Use os recursos autorizados da API.",
    );
  return c.json({
    settings: await settings(c.env, p),
    settings_revision: await settingsRevision(c.env, p),
    enabled: (await one(c.env, "SELECT enabled FROM profiles WHERE id=?", p))
      ?.enabled,
    // Contadores das conversas só para quem acessa o atendimento.
    conversations: allows(c.get("actor"), "conversations")
      ? await all(
          c.env,
          "SELECT state,count(*) count FROM conversations WHERE profile_id=? GROUP BY state",
          p,
        )
      : [],
    deliveries: await all(
      c.env,
      "SELECT status,count(*) count FROM outbox WHERE profile_id=? GROUP BY status",
      p,
    ),
    connections: await all(
      c.env,
      "SELECT id,name,kind,status,last_seen FROM connections WHERE profile_id=?",
      p,
    ),
    // Módulos ligados (true) e desligados (false): o painel esconde telas.
    modules: await moduleStates(c.env, p),
  });
});
app.get("/api/v1/profiles/:profile/router", async (c) =>
  c.json(await routerView(c.env, c.get("actor"), c.req.param("profile"))),
);
app.get("/api/v1/profiles/:profile/router/numbers/:id/templates", async (c) =>
  c.json(
    await templateCatalog(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.param("id"),
      c.req.query(),
    ),
  ),
);
app.get("/api/v1/profiles/:profile/lines", async (c) =>
  c.json(await listLines(c.env, c.get("actor"), c.req.param("profile"))),
);
app.get("/api/v1/profiles/:profile/menus", async (c) =>
  c.json(
    await listMenus(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.query("connection_id"),
    ),
  ),
);
app.get("/api/v1/profiles/:profile/team", async (c) =>
  c.json(await teamDirectory(c.env, c.get("actor"), c.req.param("profile"))),
);
// Pessoas da área para escolher responsável (aplicativos; docs/API.md).
app.get("/api/v1/profiles/:profile/people", async (c) =>
  c.json(
    await areaPeople(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.query("grant") || null,
    ),
  ),
);
app.get("/api/v1/profiles/:profile/grants", async (c) =>
  c.json(await areaGrants(c.env, c.get("actor"), c.req.param("profile"))),
);
app.get("/api/v1/profiles/:profile/internal-chats", async (c) =>
  c.json(
    await listInternalChats(c.env, c.get("actor"), c.req.param("profile")),
  ),
);
// Pedidos de aprovação à equipe (src/approvals.ts): lista e decisão, só com
// sessão de pessoa que pode decidir. O primeiro a decidir vence.
app.get("/api/v1/profiles/:profile/approvals", async (c) => {
  const actor = c.get("actor"),
    profile = c.req.param("profile");
  if (!canProfile(actor, profile))
    throw new ApiError(404, "not_found", "Perfil não encontrado.");
  return c.json(await listApprovals(c.env, actor, profile, c.req.query()));
});
app.get("/api/v1/profiles/:profile/approvals/:id", async (c) => {
  const actor = c.get("actor"),
    profile = c.req.param("profile");
  if (!canProfile(actor, profile) || actor.kind !== "user")
    throw new ApiError(404, "not_found", "Perfil não encontrado.");
  return c.json(
    approvalView(await loadApproval(c.env, profile, c.req.param("id")), actor),
  );
});
app.post("/api/v1/profiles/:profile/approvals/:id/decide", async (c) => {
  const actor = c.get("actor"),
    profile = c.req.param("profile");
  if (!canProfile(actor, profile))
    throw new ApiError(404, "not_found", "Perfil não encontrado.");
  const data = await c.req.json<any>().catch(() => ({}));
  return c.json(
    await decideApproval(
      c.env,
      actor,
      profile,
      c.req.param("id"),
      data,
      c.get("requestId"),
    ),
  );
});
// Proposta de ação do bot na conversa interna (src/bot-actions): só a pessoa
// que pediu confirma ou cancela, pela sessão dela. Idempotente pelo estado da
// proposta (confirmar de novo devolve o mesmo resultado).
for (const decision of ["confirm", "cancel"] as const)
  app.post(
    `/api/v1/profiles/:profile/internal-chats/:id/proposals/:proposal/${decision}`,
    async (c) => {
      const actor = c.get("actor"),
        profile = c.req.param("profile");
      if (!canProfile(actor, profile))
        throw new ApiError(404, "not_found", "Perfil não encontrado.");
      const run = decision === "confirm" ? confirmProposal : cancelProposal;
      return c.json(
        await run(
          c.env,
          actor,
          profile,
          c.req.param("id"),
          c.req.param("proposal"),
        ),
      );
    },
  );
app.get("/api/v1/profiles/:profile/internal-chats/:id", async (c) =>
  c.json(
    await internalChatDetail(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.param("id"),
    ),
  ),
);
app.get("/api/v1/profiles/:profile/router/messages/:id", async (c) =>
  c.json(
    await routedMessage(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.param("id"),
    ),
  ),
);
app.get("/api/public/whatsapp/:token", async (c) => {
  await rate(
    c.env,
    "router-link:" + (c.req.header("CF-Connecting-IP") || "local"),
    30,
  );
  const pool = await one(
    c.env,
    "SELECT profile_id FROM number_pools WHERE public_token=? AND enabled=1",
    c.req.param("token"),
  );
  if (!pool)
    throw new ApiError(404, "not_found", "Link de atendimento indisponível.");
  const response = await c.env.COORDINATOR.get(
    c.env.COORDINATOR.idFromName(pool.profile_id),
  ).fetch("https://coordinator/router-link", {
    method: "POST",
    body: JSON.stringify({
      profile: pool.profile_id,
      token: c.req.param("token"),
    }),
  });
  if (!response.ok) return response;
  const result = await response.json<any>();
  return c.redirect(result.url, 302);
});
app.get("/api/v1/profiles/:profile/connections", async (c) => {
  admin(c.get("actor"));
  return c.json(
    await all(
      c.env,
      "SELECT * FROM connections WHERE profile_id=?",
      c.req.param("profile"),
    ),
  );
});
for (const op of [
  "test",
  "connector-token",
])
  app.post("/api/v1/profiles/:profile/connections/:id/" + op, async (c) => {
    admin(c.get("actor"));
    return mutate(c, "connection." + op, c.req.param("profile")!, {
      id: c.req.param("id"),
      origin: new URL(c.req.url).origin,
    });
  });
app.post("/api/v1/profiles/:profile/jev", async (c) =>
  mutate(c, "jev", c.req.param("profile"), await c.req.json()),
);
const readLists: Record<string, [string, string]> = {
  bots: ["bots", "bots:read"],
  tickets: ["tickets", "tickets:read"],
  knowledge: ["documents", "knowledge:read"],
  surveys: ["surveys", "reports:read"],
  consents: ["consents", "conversations:read"],
  deliveries: ["outbox", "conversations:read"],
  "bot-runs": ["bot_runs", "bots:invoke"],
  media: ["media", "media:read"],
};
for (const [path, [table, scope]] of Object.entries(readLists))
  app.get(`/api/v1/profiles/:profile/${path}`, async (c) => {
    const p = c.req.param("profile")!;
    access(c.get("actor"), p, scope);
    const actor = c.get("actor"),
      limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 100)),
      cursor = c.req.query("cursor") || "";
    let filter = "",
      params: any[] = [p, cursor];
    if (table === "bot_runs") {
      // A person sees only the runs they asked for: the bot screens build
      // their history from this list, so anything else would show colleagues'
      // questions and customer conversations. Administrators get the full
      // list (the Execuções de bots page) by asking for it with all=1; other
      // people's internal chats stay hidden even then.
      const everything =
        actor.kind === "user" &&
        actor.role === "admin" &&
        c.req.query("all") === "1";
      if (actor.kind === "user" && !everything) {
        filter += " AND actor=?";
        params.push(actor.id);
      } else {
        filter +=
          " AND (json_extract(context,'$.internal_chat_id') IS NULL OR actor=?)";
        params.push(actor.id);
      }
    }
    if (actor.kind === "app") {
      if (table === "bots") {
        filter += " AND id IN (SELECT value FROM json_each(?))";
        params.push(JSON.stringify(actor.bots));
      }
      if (table === "bot_runs" || table === "media") {
        filter += " AND actor=?";
        params.push(actor.id);
      }
      if (["tickets", "surveys", "consents", "outbox"].includes(table)) {
        filter += ` AND conversation_id IN (SELECT id FROM conversations WHERE external_namespace NOT LIKE 'app:%' OR external_namespace=?)`;
        params.push("app:" + actor.id);
      }
    }
    if (table === "tickets") {
      const q = (c.req.query("q") || "").trim().slice(0, 200);
      if (q) {
        const phone = q.replace(/\D/g, "");
        filter +=
          " AND (number LIKE ? OR conversation_id IN (SELECT id FROM conversations WHERE profile_id=? AND ?!='' AND phone LIKE ?))";
        params.push(`%${q}%`, p, phone, `%${phone}%`);
      }
      const status = c.req.query("status");
      if (status) {
        // One state or a comma-separated list, combined with OR.
        const wanted = [...new Set(status.split(",").map((s) => s.trim()))];
        requireValue(
          wanted.every((s) => ticketStatuses.includes(s)),
          "Estado inválido.",
        );
        filter += " AND status IN (SELECT value FROM json_each(?))";
        params.push(JSON.stringify(wanted));
      }
      // Active: neither resolved nor closed.
      if (c.req.query("active") === "1") filter += ` AND ${activeTicketSql()}`;
      const category = (c.req.query("category") || "").slice(0, 100);
      if (category) {
        filter += " AND category=?";
        params.push(category);
      }
      if (c.req.query("overdue") === "1") {
        filter += ` AND response_due_at<? AND first_response_at IS NULL AND ${activeTicketSql()}`;
        params.push(now());
      }
    }
    const rows = await all(
      c.env,
      `SELECT * FROM ${table} WHERE profile_id=? AND id>? ${filter} ORDER BY id LIMIT ?`,
      ...params,
      limit + 1,
    );
    const more = rows.length > limit;
    rows.splice(limit);
    if (table === "bots" && rows.length) {
      // O painel mostra o provedor de IA e o modelo do bot.
      const connections = await all(
        c.env,
        "SELECT id,kind,config FROM connections WHERE profile_id=?",
        p,
      );
      for (const row of rows) {
        const connection = connections.find((x) => x.id === row.connection_id);
        row.connection_kind = connection?.kind || null;
        if (connection?.kind === "ai") {
          const cfg = json(connection.config);
          row.mask_personal = cfg.bot_options?.[row.remote_profile]?.mask_personal !== false;
          row.pdf_raw_fallback = cfg.bot_options?.[row.remote_profile]?.pdf_raw_fallback === true;
          row.image_to_team = cfg.bot_options?.[row.remote_profile]?.image_to_team === true;
          row.provider = cfg.provider;
          row.model = cfg.model;
          // O provedor recusou as ferramentas numa execução (até salvar a
          // conexão de novo): o painel avisa.
          row.tools_unsupported = !!cfg.tools_unsupported_at;
        }
      }
    }
    for (const row of rows) {
      if (table === "bot_runs") row.input = runQuestion(row);
      delete row.object_key;
      delete row.context;
      delete row.request_body;
    }
    return c.json({ data: rows, next_cursor: more ? rows.at(-1)?.id : null });
  });
app.get("/api/v1/profiles/:profile/tickets/:id", async (c) => {
  const p = c.req.param("profile"),
    actor = c.get("actor");
  access(actor, p, "tickets:read");
  const ticket = await one(
    c.env,
    "SELECT * FROM tickets WHERE id=? AND profile_id=?",
    c.req.param("id"),
    p,
  );
  if (!ticket)
    throw new ApiError(404, "not_found", "Protocolo não encontrado.");
  const conv = await conversation(c.env, ticket.conversation_id, p, actor);
  const contact =
    actor.kind === "user" || actor.scopes.includes("contacts:read")
      ? await one(
          c.env,
          "SELECT ct.name FROM conversation_contacts l JOIN contacts ct ON ct.id=l.contact_id AND ct.profile_id=l.profile_id WHERE l.profile_id=? AND l.conversation_id=? AND ct.identity_state='active' AND (?=1 OR ct.namespace=?)",
          p,
          conv.id,
          actor.kind === "user" ? 1 : 0,
          contactNamespace(actor),
        )
      : null;
  return c.json({
    ticket,
    updates: await all(
      c.env,
      "SELECT * FROM ticket_updates WHERE ticket_id=? ORDER BY created,id",
      ticket.id,
    ),
    conversation: {
      id: conv.id,
      phone: conv.phone,
      external_id: conv.external_id,
      title: conv.title,
      state: conv.state,
      owner: conv.owner,
      contact_name: contact?.name || null,
    },
  });
});
app.get("/api/v1/profiles/:profile/contacts", async (c) =>
  c.json(
    await listContacts(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.query(),
    ),
  ),
);
app.get("/api/v1/profiles/:profile/contacts/:id", async (c) =>
  c.json(
    await contactDetail(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.param("id"),
    ),
  ),
);
for (const [path, kind] of [
  ["contacts/:id/history", "history"],
  ["conversations/:id/customer-history", "conversation-history"],
  ["contacts/:id/profile", "profile"],
  ["contacts/:id/modules/:module/collections/:collection", "collection"],
  ["contacts/:id/modules/:module/sections/:section", "section"],
] as const) app.get(`/api/v1/profiles/:profile/${path}`, async c => c.json(await customerRead(
  c.env, c.get("actor"), c.req.param("profile")!, c.req.param("id")!, kind,
  c.req.query(), c.req.param("module"), c.req.param("collection") ?? c.req.param("section"),
)));
app.get("/api/v1/profiles/:profile/contact-conflicts", async c => c.json(await contactConflicts(c.env, c.get("actor"), c.req.param("profile"), c.req.query())));
app.get("/api/v1/profiles/:profile/contact-jobs/:id", async c => c.json(await readJob(c.env, c.get("actor"), c.req.param("profile"), c.req.param("id"))));
app.post("/api/v1/profiles/:profile/contacts/import/preview", async (c) => {
  await rate(c.env, `contacts-preview:${c.get("actor").id}`, 20);
  const data = await c.req.json();
  return c.json(
    await previewContactCsv(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      data.csv,
      data.phone_mode,
    ),
  );
});
const messageKinds = [
  "text",
  "image",
  "video",
  "audio",
  "document",
  "location",
  "contacts",
  "sticker",
  "interactive",
];
/** Replaces the joined lm_* columns of a conversation row with last_message. */
function lastMessageView(row: any) {
  const {
    lm_text,
    lm_direction,
    lm_created,
    lm_delivery_status,
    lm_attachments,
    lm_content,
    lm_media_type,
    ...conversation
  } = row;
  if (!lm_direction) return { ...conversation, last_message: null };
  const content = json(lm_content),
    attachments = json(lm_attachments, []);
  const count = Array.isArray(attachments) ? attachments.length : 0;
  let kind = content.type === "voice" ? "audio" : content.type;
  if (kind === "file") kind = "document";
  if ((!kind || kind === "text") && count)
    kind = lm_media_type ? mediaKind(lm_media_type) : "document";
  if (content.deleted || !messageKinds.includes(kind))
    kind = count && !content.deleted ? "document" : "text";
  return {
    ...conversation,
    last_message: {
      text: lm_text || "",
      direction: lm_direction,
      created: lm_created,
      delivery_status: lm_delivery_status || "",
      attachments: count,
      kind,
    },
  };
}
app.get("/api/v1/profiles/:profile/conversations", async (c) => {
  const p = c.req.param("profile");
  access(c.get("actor"), p, "conversations:read");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 50));
  let after: any = null;
  try {
    after = c.req.query("cursor")
      ? JSON.parse(atob(c.req.query("cursor")!))
      : null;
  } catch {
    throw new ApiError(400, "invalid_cursor", "Cursor inválido.");
  }
  const state = c.req.query("state") || "",
    department = (c.req.query("department_id") || "").slice(0, 100),
    q = (c.req.query("q") || "").slice(0, 200);
  // The page is selected first; the newest message is then looked up once per
  // returned conversation through messages_history(conversation_id,created,id).
  // Internal notes only count for callers allowed to read them.
  const notes =
    c.get("actor").kind !== "app" ||
    c.get("actor").scopes.includes("notes:read");
  const rows = await all(
    c.env,
    "SELECT p.*,substr(lm.text,1,300) lm_text,lm.direction lm_direction,lm.created lm_created,lm.delivery_status lm_delivery_status,lm.attachments lm_attachments,lm.content lm_content,(SELECT a.type FROM media a WHERE a.id=json_extract(lm.attachments,'$[0]')) lm_media_type FROM (SELECT c.*,ct.name contact_name,ct.id contact_id FROM conversations c LEFT JOIN conversation_contacts l ON l.conversation_id=c.id AND l.profile_id=c.profile_id LEFT JOIN contacts ct ON ct.id=l.contact_id AND ct.profile_id=c.profile_id AND ct.identity_state='active' AND ?=1 AND (?=1 OR ct.namespace=?) WHERE c.profile_id=? AND (?='' OR c.state=?) AND (?='' OR c.department_id=?) AND (c.external_id LIKE ? OR c.phone LIKE ? OR ct.name LIKE ?) AND (?=1 OR c.external_namespace NOT LIKE 'app:%' OR c.external_namespace=?) AND (? IS NULL OR c.updated<? OR (c.updated=? AND c.id<?)) ORDER BY c.updated DESC,c.id DESC LIMIT ?) p LEFT JOIN messages lm ON lm.id=(SELECT m.id FROM messages m WHERE m.conversation_id=p.id AND (?=1 OR m.direction!='note') ORDER BY m.created DESC,m.id DESC LIMIT 1) ORDER BY p.updated DESC,p.id DESC",
    c.get("actor").kind === "user" ||
      c.get("actor").scopes.includes("contacts:read")
      ? 1
      : 0,
    c.get("actor").kind === "user" ? 1 : 0,
    contactNamespace(c.get("actor")),
    p,
    state,
    state,
    department,
    department,
    `%${q}%`,
    `%${q}%`,
    `%${q}%`,
    c.get("actor").kind !== "app" ? 1 : 0,
    "app:" + c.get("actor").id,
    after?.[0] ?? null,
    after?.[0] ?? 0,
    after?.[0] ?? 0,
    after?.[1] ?? "",
    limit + 1,
    notes ? 1 : 0,
  );
  const more = rows.length > limit;
  rows.splice(limit);
  const last = rows.at(-1);
  return c.json({
    data: rows.map(lastMessageView),
    next_cursor:
      more && last ? btoa(JSON.stringify([last.updated, last.id])) : null,
  });
});
app.get("/api/v1/profiles/:profile/conversations/:id", async (c) => {
  const p = c.req.param("profile"),
    actor = c.get("actor");
  access(actor, p, "conversations:read");
  const conv = await conversation(c.env, c.req.param("id"), p, actor);
  const notes = actor.kind !== "app" || actor.scopes.includes("notes:read");
  const conn = conv.connection_id
    ? await one(
        c.env,
        "SELECT * FROM connections WHERE id=?",
        conv.connection_id,
      )
    : null;
  const media = await all(
    c.env,
    "SELECT DISTINCT a.id,a.name,a.type,a.size FROM media a JOIN messages m ON m.profile_id=a.profile_id AND EXISTS(SELECT 1 FROM json_each(m.attachments) WHERE value=a.id) WHERE m.conversation_id=? AND (?=1 OR m.direction!='note')",
    conv.id,
    notes ? 1 : 0,
  );
  return c.json({
    conversation: conv,
    // Passagem feita por um módulo: resumo e marcadores para o atendente
    // (interno, como as notas).
    handoff: notes ? json(conv.handoff, null) : null,
    connection_kind: conn?.kind || null,
    server_now: now(),
    media,
    capabilities: conn ? capabilities(conn, conv.chat_type) : {},
    group:
      conv.chat_type === "group"
        ? await one(
            c.env,
            "SELECT * FROM whatsapp_groups WHERE conversation_id=?",
            conv.id,
          )
        : null,
    contact: await conversationContact(c.env, actor, p, conv.id),
    messages: await all(
      c.env,
      "SELECT * FROM messages WHERE conversation_id=? AND (?=1 OR direction!='note') ORDER BY created,id",
      conv.id,
      notes ? 1 : 0,
    ),
    deliveries: await all(
      c.env,
      "SELECT id,status,error,created FROM outbox WHERE conversation_id=? ORDER BY created",
      conv.id,
    ),
    // Cobranças da conversa (criada, paga, expirada, cancelada, estornada).
    payments: (
      await all(
        c.env,
        "SELECT * FROM payments WHERE conversation_id=? ORDER BY created DESC,id DESC LIMIT 20",
        conv.id,
      )
    ).map(paymentView),
    // Passos web da conversa (enviado, aberto, concluído, expirado). Respostas
    // só com contacts:read (segunda conferência, M6), como em /web-steps.
    web_steps: (
      await all(
        c.env,
        "SELECT * FROM web_steps WHERE conversation_id=? ORDER BY created DESC,id DESC LIMIT 20",
        conv.id,
      )
    ).map((row) => stepFor(c.get("actor"), row)),
  });
});
app.get("/api/v1/profiles/:profile/conversations/:id/web-steps", async (c) =>
  c.json(
    await listWebSteps(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.param("id"),
    ),
  ),
);
app.get("/api/v1/profiles/:profile/web-steps/:id", async (c) =>
  c.json(
    await getWebStep(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.param("id"),
    ),
  ),
);
app.get("/api/v1/profiles/:profile/presence", async (c) => {
  access(c.get("actor"), c.req.param("profile"), "presence:read");
  return c.json(
    await all(
      c.env,
      "SELECT u.id actor,u.name,coalesce(p.present,0) present FROM users u LEFT JOIN presence p ON p.actor=u.id AND p.profile_id=? WHERE u.disabled=0 AND (u.role='admin' OR EXISTS(SELECT 1 FROM json_each(u.profiles) WHERE value=?))",
      c.req.param("profile"),
      c.req.param("profile"),
    ),
  );
});
app.get("/api/v1/profiles/:profile/events", async (c) => {
  access(c.get("actor"), c.req.param("profile"), "events:read");
  const after = Number(c.req.query("after")) || 0;
  const rows = await all(
    c.env,
    "SELECT * FROM events WHERE profile_id=? AND id>? ORDER BY id LIMIT 100",
    c.req.param("profile"),
    after,
  );
  return c.json({
    data: (
      await Promise.all(
        rows.map(async (e) =>
          (await visibleEvent(c.env, c.get("actor"), e))
            ? { ...e, payload: json(e.payload) }
            : null,
        ),
      )
    ).filter(Boolean),
    cursor: rows.at(-1)?.id || after,
  });
});
app.get("/api/v1/profiles/:profile/modules", async (c) =>
  c.json(await listModules(c.env, c.get("actor"), c.req.param("profile"))),
);
// Fila de senhas: leituras e WebSocket dos painéis.
app.get("/api/v1/profiles/:profile/queue", async (c) => {
  queueRead(c.get("actor"), c.req.param("profile"));
  return c.json(await queueOverview(c.env, c.req.param("profile")));
});
app.get("/api/v1/profiles/:profile/queue/tickets", async (c) =>
  c.json(
    await listQueueTickets(c.env, c.get("actor"), c.req.param("profile"), {
      queue_id: c.req.query("queue_id"),
      status: c.req.query("status"),
      day: c.req.query("day"),
    }),
  ),
);
app.get("/api/v1/profiles/:profile/queue/tickets/:id", async (c) =>
  c.json(
    await getQueueTicket(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.param("id"),
    ),
  ),
);
app.get("/api/v1/profiles/:profile/queue/blocklist", async (c) =>
  c.json(await listBlocklist(c.env, c.get("actor"), c.req.param("profile"))),
);
app.get("/api/v1/profiles/:profile/queue/displays", async (c) =>
  c.json(await listDisplays(c.env, c.get("actor"), c.req.param("profile"))),
);
app.get("/api/v1/profiles/:profile/queue/ws", async (c) => {
  queueRead(c.get("actor"), c.req.param("profile"));
  return queueSocket(
    c.env,
    c.req.raw,
    c.req.param("profile"),
    [],
    await credentialTags(c.req.raw, c.get("actor")),
    c.get("actor").expiresAt,
  );
});
app.get("/api/v1/profiles/:profile/webhook-subscriptions", async (c) => {
  access(c.get("actor"), c.req.param("profile"), "webhooks:manage");
  return c.json(
    await all(
      c.env,
      "SELECT * FROM webhook_subscriptions WHERE profile_id=? AND (?=1 OR app_id=?)",
      c.req.param("profile"),
      c.get("actor").role === "admin" ? 1 : 0,
      c.get("actor").id.slice(4),
    ),
  );
});
app.get("/api/v1/profiles/:profile/webhook-deliveries", async (c) => {
  access(c.get("actor"), c.req.param("profile"), "webhooks:manage");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 100));
  const rows = await all(
    c.env,
    "SELECT d.* FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE s.profile_id=? AND (?=1 OR s.app_id=?) AND d.id>? ORDER BY d.id LIMIT ?",
    c.req.param("profile"),
    c.get("actor").role === "admin" ? 1 : 0,
    c.get("actor").id.slice(4),
    c.req.query("cursor") || "",
    limit + 1,
  );
  const more = rows.length > limit;
  rows.splice(limit);
  return c.json({ data: rows, next_cursor: more ? rows.at(-1)?.id : null });
});
app.get("/api/v1/profiles/:profile/reports", (c) =>
  report(
    c.env,
    c.get("actor"),
    c.req.param("profile"),
    new URL(c.req.url).searchParams,
  ),
);
app.post("/api/v1/profiles/:profile/media", async (c) => {
  const p = c.req.param("profile"),
    actor = c.get("actor");
  access(actor, p, "media:write");
  const form = await c.req.formData(),
    file = form.get("file");
  requireValue(
    file instanceof File && file.size > 0 && file.size <= 20 * 1024 * 1024,
    "Envie um arquivo de até 20 MB.",
  );
  const idem = c.req.header("Idempotency-Key");
  requireValue(idem && idem.length <= 200, "Envie Idempotency-Key.");
  const bytes = await file.arrayBuffer(),
    digest = hex(await crypto.subtle.digest("SHA-256", bytes));
  const id = (await sha(actor.id + ":" + p + ":" + idem)).slice(0, 32),
    key = `${p}/${id}/${digest}`;
  await c.env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });
  const result = await mutate(c, "media.register", p, {
    id,
    object_key: key,
    name: file.name.slice(0, 200),
    type: file.type || "application/octet-stream",
    size: file.size,
    digest,
  });
  if (
    !result.ok &&
    !(await one(c.env, "SELECT id FROM media WHERE object_key=?", key))
  )
    await c.env.MEDIA.delete(key);
  return result;
});
app.get("/api/v1/profiles/:profile/media/:id/content", async (c) => {
  const p = c.req.param("profile"),
    actor = c.get("actor");
  access(actor, p, "media:read");
  return mediaResponse(
    c.env,
    await authorizedMedia(c.env, actor, p, c.req.param("id")),
    c.req.raw,
  );
});
app.put("/api/v1/profiles/:profile/media/uploads/:id/parts/:part", async (c) =>
  c.json(
    await uploadPart(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.param("id"),
      Number(c.req.param("part")),
      c.req.raw,
    ),
  ),
);
app.get("/api/v1/profiles/:profile/connections/:id/capabilities", async (c) => {
  access(c.get("actor"), c.req.param("profile"), "conversations:read");
  const row = await one(
    c.env,
    "SELECT * FROM connections WHERE id=? AND profile_id=?",
    c.req.param("id"),
    c.req.param("profile"),
  );
  requireValue(row, "Conexão não encontrada.");
  return c.json(capabilities(row));
});
app.get("/api/v1/profiles/:profile/calls", async (c) => {
  const actor = c.get("actor"),
    p = c.req.param("profile");
  access(actor, p, "calls:read");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 30)),
    cursor = c.req.query("cursor") || "",
    cid = c.req.query("conversation_id") || "";
  let after = { created: Number.MAX_SAFE_INTEGER, id: "" };
  if (cursor) {
    try {
      after = JSON.parse(atob(cursor));
      if (!Number.isSafeInteger(after.created) || typeof after.id !== "string")
        throw Error();
    } catch {
      throw new ApiError(400, "invalid_cursor", "Cursor inválido.");
    }
  }
  const rows = await all(
    c.env,
    "SELECT id,conversation_id,direction,actor,status,error,started,ended,duration,created,updated FROM calls WHERE profile_id=? AND (?=1 OR actor=? OR actor IS NULL) AND (?='' OR conversation_id=?) AND (created<? OR (created=? AND id<?)) ORDER BY created DESC,id DESC LIMIT ?",
    p,
    actor.kind !== "app" ? 1 : 0,
    actor.id,
    cid,
    cid,
    after.created,
    after.created,
    after.id,
    limit + 1,
  );
  return c.json({
    data: rows.slice(0, limit),
    next_cursor:
      rows.length > limit
        ? btoa(
            JSON.stringify({
              created: rows[limit - 1].created,
              id: rows[limit - 1].id,
            }),
          )
        : null,
  });
});
app.get("/api/v1/profiles/:profile/calls/:id", async (c) =>
  c.json(
    await callView(
      c.env,
      c.get("actor"),
      c.req.param("profile"),
      c.req.param("id"),
      c.req.query("session") === "1",
    ),
  ),
);
app.get(
  "/api/v1/profiles/:profile/conversations/:id/call-permission",
  async (c) => {
    const actor = c.get("actor"),
      p = c.req.param("profile");
    access(actor, p, "calls:read");
    const conv = await conversation(c.env, c.req.param("id"), p, actor),
      conn = await one(
        c.env,
        "SELECT * FROM connections WHERE id=?",
        conv.connection_id,
      );
    requireValue(
      conn && conv.chat_type !== "group",
      "Selecione uma conversa individual com canal WhatsApp.",
    );
    return c.json(
      await callPermission(c.env, conn, conv.recipient_id || conv.external_id),
    );
  },
);
app.get("/api/v1/profiles/:profile/groups", async (c) => {
  const actor = c.get("actor"),
    p = c.req.param("profile");
  access(actor, p, "conversations:read");
  const cursor = c.req.query("cursor") || "";
  const rows = await all(
    c.env,
    "SELECT * FROM conversations WHERE profile_id=? AND chat_type='group' AND (?='' OR id<?) ORDER BY id DESC LIMIT 51",
    p,
    cursor,
    cursor,
  );
  return c.json({
    data: rows.slice(0, 50),
    next_cursor: rows.length > 50 ? rows[49].id : null,
  });
});
app.get("/api/v1/profiles/:profile/group-operations", async (c) => {
  const actor = c.get("actor"),
    p = c.req.param("profile");
  access(actor, p, "groups:manage");
  return c.json({
    data: await all(
      c.env,
      "SELECT id,connection_id,conversation_id,operation,status,result,error,created FROM group_operations WHERE profile_id=? AND (?=1 OR actor=?) ORDER BY created DESC LIMIT 30",
      p,
      actor.kind !== "app" ? 1 : 0,
      actor.id,
    ),
  });
});
async function ingest(env: Env, conn: any, data: any) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(conn.profile_id)).fetch(
    data.event
      ? "https://coordinator/channel-event"
      : "https://coordinator/inbound",
    {
      method: "POST",
      body: JSON.stringify({
        profile: conn.profile_id,
        data,
        namespace: `channel:${conn.id}`,
        connectionId: conn.id,
      }),
    },
  );
}
// Retired endpoints explicitly reject requests instead of silently dropping messages.
for (const path of ["/webhooks/meta/:id", "/webhooks/meta-accounts/:id"])
  app.on(["GET", "POST"], path, () => {
    throw new ApiError(410, "meta_removed", "Configure o webhook na Zernio.");
  });
app.post("/webhooks/zernio/:id", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=? AND kind='zernio'",
    c.req.param("id"),
  );
  requireValue(conn, "Canal não encontrado.");
  const keys = await zernioCredentials(c.env, conn),
    raw = await c.req.text();
  if (
    !(await verifyZernioWebhook(
      keys.webhook_secret,
      raw,
      c.req.header("X-Zernio-Signature") || "",
    ))
  )
    throw new ApiError(403, "invalid_signature", "Assinatura inválida.");
  const body = json(raw, null);
  requireValue(body && typeof body === "object", "Webhook Zernio inválido.");
  return zernioInbound(c.env, conn, body, (data) => ingest(c.env, conn, data));
});
app.post("/webhooks/zernio-accounts/:id", async (c) => {
  const account = await one(
    c.env,
    "SELECT * FROM meta_accounts WHERE id=? AND provider='zernio'",
    c.req.param("id"),
  );
  requireValue(account, "Conta Zernio não encontrada.");
  const keys = await secret(c.env, "zernio-account:" + account.id),
    raw = await c.req.text();
  if (
    !(await verifyZernioWebhook(
      keys.webhook_secret,
      raw,
      c.req.header("X-Zernio-Signature") || "",
    ))
  )
    throw new ApiError(403, "invalid_signature", "Assinatura inválida.");
  const body = json(raw, null);
  requireValue(body && typeof body === "object", "Webhook Zernio inválido.");
  const connections = await all(
    c.env,
    "SELECT c.* FROM connections c JOIN meta_numbers n ON n.connection_id=c.id WHERE n.account_id=? AND c.profile_id=? AND c.kind='zernio'",
    account.id,
    account.profile_id,
  );
  for (const conn of connections) {
    const response = await zernioInbound(c.env, conn, body, (data) =>
      ingest(c.env, conn, data),
    );
    if (!response.ok) return response;
  }
  return c.json({ received: true });
});
// Webhook de pagamento (docs/COBRANCA.md). A assinatura é conferida aqui; o
// estado só muda depois da consulta ao provedor, no Coordinator da área.
app.post("/webhooks/payments/:provider/:account", async (c) => {
  // Limite por IP antes de qualquer consulta (revisão B2).
  await rate(
    c.env,
    "payment-webhook:" +
      (await sha(c.req.header("CF-Connecting-IP") || "local")),
    240,
  );
  const url = new URL(c.req.url);
  const body = json(await c.req.text(), {});
  const { account, paymentId } = await verifyPaymentWebhook(
    c.env,
    c.req.param("provider"),
    c.req.param("account"),
    { headers: c.req.raw.headers, query: url.searchParams, body },
  );
  if (!paymentId) return c.json({ received: true, ignored: true });
  const response = await c.env.COORDINATOR.get(
    c.env.COORDINATOR.idFromName(account.profile_id),
  ).fetch("https://coordinator/payment-webhook", {
    method: "POST",
    body: JSON.stringify({
      profile: account.profile_id,
      account: account.id,
      payment_id: paymentId,
    }),
  });
  // Falha ao consultar o provedor: o erro faz o provedor reenviar depois.
  if (!response.ok) return response;
  return c.json({ received: true, ...(await response.json<any>()) });
});
// Telegram was removed. A bot still pointing here gets a final answer.
app.post("/webhooks/telegram/:id", () => {
  throw telegramRemoved();
});
app.use("/internal/v1/connectors/:id/*", async (c, next) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=? AND kind='qr'",
    c.req.param("id"),
  );
  if (!conn) throw new ApiError(401, "unauthenticated", "Conector inválido.");
  const keys = await secret(c.env, `connection:${conn.id}`),
    token = c.req.header("Authorization")?.replace(/^Bearer /, "") || "";
  if (!keys.connector_hash || !equal(await sha(token), keys.connector_hash))
    throw new ApiError(401, "unauthenticated", "Token inválido.");
  await exec(
    c.env,
    "UPDATE connections SET last_seen=? WHERE id=?",
    now(),
    conn.id,
  );
  await next();
});
app.post("/internal/v1/connectors/:id/events", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  return ingest(c.env, conn, await c.req.json());
});
async function transportCommand(c: any, operation: string, data: any = {}) {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  return c.env.COORDINATOR.get(
    c.env.COORDINATOR.idFromName(conn.profile_id),
  ).fetch("https://coordinator/transport", {
    method: "POST",
    body: JSON.stringify({
      profile: conn.profile_id,
      connectionId: conn.id,
      operation,
      data,
    }),
  });
}
app.get("/internal/v1/connectors/:id/commands", (c) =>
  transportCommand(c, "commands"),
);
app.post("/internal/v1/connectors/:id/commands/:command/check", (c) =>
  transportCommand(c, "check", { id: c.req.param("command") }),
);
app.post("/internal/v1/connectors/:id/receipts", async (c) =>
  transportCommand(c, "receipt", await c.req.json()),
);
app.get("/internal/v1/connectors/:id/media/:media", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  const m = await one(
    c.env,
    "SELECT * FROM media WHERE id=? AND profile_id=?",
    c.req.param("media"),
    conn.profile_id,
  );
  requireValue(m, "Arquivo não encontrado.");
  const obj = await c.env.MEDIA.get(m.object_key);
  requireValue(obj, "Arquivo ausente.");
  return new Response(obj.body, {
    headers: {
      "Content-Type": m.type,
      "X-Filename": encodeURIComponent(m.name),
      "Content-Length": String(m.size),
    },
  });
});
app.post("/internal/v1/connectors/:id/media-content", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  const size = Number(c.req.header("Content-Length") || 0);
  requireValue(
    Number.isSafeInteger(size) && size > 0 && size <= 100 * 1024 * 1024,
    "Arquivo deve ter de 1 byte a 100 MB.",
  );
  const key = c.req.header("Idempotency-Key");
  requireValue(key && key.length <= 200, "Informe Idempotency-Key.");
  const id = (await sha(conn.id + ":" + key)).slice(0, 32);
  const existing = await one(
    c.env,
    "SELECT id,size FROM media WHERE id=? AND profile_id=?",
    id,
    conn.profile_id,
  );
  if (existing) {
    requireValue(
      existing.size === size,
      "A chave já foi usada para outro arquivo.",
    );
    return c.json({ id });
  }
  const name = decodeURIComponent(c.req.header("X-Filename") || "anexo").slice(
      0,
      200,
    ),
    type = c.req.header("Content-Type") || "application/octet-stream";
  await storeRemoteMedia(
    c.env,
    conn.profile_id,
    name,
    type,
    new Response(c.req.raw.body, {
      headers: { "Content-Length": String(size) },
    }),
    { id, actor: "transport:" + conn.id },
  );
  return c.json({ id });
});
app.post("/internal/v1/connectors/:id/media", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  const form = await c.req.formData(),
    file = form.get("file");
  requireValue(
    file instanceof File && file.size <= 20 * 1024 * 1024,
    "Arquivo inválido.",
  );
  const id = await storeRemoteMedia(
    c.env,
    conn.profile_id,
    file.name,
    file.type,
    new Response(file.stream(), {
      headers: { "Content-Length": String(file.size) },
    }),
  );
  return c.json({ id });
});
app.get("/internal/v1/connectors/:id/policy", async (c) => {
  const conn = await one(
    c.env,
    "SELECT * FROM connections WHERE id=?",
    c.req.param("id"),
  );
  return c.json({
    notifications: (await settings(c.env, conn.profile_id)).notifications,
  });
});
app.post("/internal/v1/connectors/:id/status", async (c) => {
  const data = await c.req.json(),
    conn = await one(
      c.env,
      "SELECT * FROM connections WHERE id=?",
      c.req.param("id"),
    );
  await exec(
    c.env,
    "UPDATE connections SET config=? WHERE id=?",
    JSON.stringify({
      ...json(conn.config),
      qr: data.qr || null,
      protocol_version: Number(data.protocol_version) || 1,
      features: Array.isArray(data.features)
        ? data.features.filter((x: any) => typeof x === "string").slice(0, 30)
        : [],
      ...(data.approved_template
        ? {
            approved_template: data.approved_template,
            template_checked_at: now(),
          }
        : {}),
      ...(data.platform &&
      ["whatsapp", "whatsapp_cloud"].includes(data.platform)
        ? { platform: data.platform }
        : {}),
      transport_state: String(data.state || "unknown").slice(0, 40),
    }),
    conn.id,
  );
  return c.json({ ok: true });
});
mountInternalApi(app);
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(wake(env, "_admin"));
    // Limpeza da migração no cron, sem uma consulta extra a cada alarme de atendimento.
    ctx.waitUntil(removePendingConnections(env));
    // Agendador do ERP (docs/ERP-AGENDADOR.md): rede de segurança do alarme
    // de cada objeto erp:<área>. Só no primeiro disparo da hora e só nas
    // áreas com o ERP ligado (src/erp/scheduler/cron.ts).
    ctx.waitUntil(wakeErpAreas(env, event.scheduledTime));
    for (const profile of await all(env, "SELECT id FROM profiles")) {
      ctx.waitUntil(wake(env, profile.id));
      // Invocação dedicada; não acrescenta trabalho ao alarme das mensagens.
      ctx.waitUntil(env.COORDINATOR.get(env.COORDINATOR.idFromName(profile.id)).fetch("https://coordinator/command", {
        method: "POST",
        body: JSON.stringify({ profile: profile.id, operation: "contact.maintain",
          actor: { id: "customer-maintenance", kind: "connector", name: "Manutenção cadastral", role: "service", profiles: [profile.id], scopes: [], bots: [], rate: 1, runLimit: 1 },
          data: {}, key: `customer-maintenance:${event.scheduledTime}`, requestId: `customer-maintenance:${event.scheduledTime}` }),
      }).then(response => { if (!response.ok) throw new Error(`Manutenção cadastral: ${response.status}`); }));
    }
    ctx.waitUntil(
      exec(env, "DELETE FROM rate_limits WHERE expires<?", now() - 600000),
    );
    ctx.waitUntil(exec(env, "DELETE FROM sessions WHERE expires<?", now()));
    ctx.waitUntil(prunePush(env));
    ctx.waitUntil(prunePairings(env));
  },
};
