// Carrega o código dos módulos embutidos, que registra seus ganchos
// (src/modules/hooks.ts) ao ser importado. Importado pela entrada do Worker,
// pelo motor e pelo serviço: um módulo novo entra nesta lista e em
// modules[] de src/modules/registry.ts.
import "./forms/forms";
import "./agenda/agenda";
import "./os/os";
import "./payments/payments";
import "./mensalidade/mensalidade";
import "./suporte/suporte";
import "./reserva/reserva";
import "./pedido/pedido";
import "./mesas/mesas";
import "./entrega/entrega";
// Fila do núcleo: só a ferramenta "minha senha" do bot (src/queue.ts).
import "./queue-tools";
import "./os/extension-runtime";

// REGISTRO RESERVADO F0/I — novos registros no fim deste bloco.
// A exporta AdminExtension; importar aqui e chamar registerAdminExtension.
// T/P/D/L entram somente na lista de os/extensions.ts.
import { onSettingsSave, registerAdminExtension } from "./api";
import { createAreaTemplatesExtension, validateAreaSetup } from "../area-templates";

onSettingsSave("os", "os_area_setup", validateAreaSetup);
registerAdminExtension(createAreaTemplatesExtension());

// REGISTRO I2 — cada descritor é registrado uma vez; execução depende da área.
import { registerJuridico } from "./juridico/juridico";
import { registerCondominio } from "./condominio/condominio";
import { onBinaryRead, onBinaryUpload, onCommand, onRoute, onRead, onMenuChoice, onConversationAction, onMcpTool, onCredentialClaim } from "./api";
import { saudeExtension } from "./saude/saude";
import { ensinoReads, ensinoWrites, ensinoCommands, ensinoTool, requestAccess, customerAction, claimAccess } from "./ensino/ensino";
registerJuridico();
registerCondominio();
for (const item of saudeExtension.commands) onCommand("saude", item.op, item.handler);
for (const item of saudeExtension.writes) onRoute("saude", item);
for (const item of saudeExtension.binaryReads) onBinaryRead("saude", item.path, item.handler);
for (const item of saudeExtension.binaryUploads) onBinaryUpload("saude", item.path, item.handler);
for (const item of ensinoReads) onRead("ensino", item.path, item.handler, item.options);
for (const item of ensinoWrites) onRoute("ensino", item);
for (const item of ensinoCommands) onCommand("ensino", item.op, item.handler);
onMenuChoice("ensino_boletim", async (ctx, c, _item, { rowId }) => { await requestAccess(ctx, c, `menu:${rowId}`); });
onConversationAction("ensino", "ensino_boletim", (ctx, actor, c, data, { requestId }) => customerAction(ctx, actor, c, data, requestId));
onMcpTool("ensino", ensinoTool);
onCredentialClaim("ensino", claimAccess);

// Fase 1: agregador autorizado da ficha; provedores se registram em seus módulos.
import { installProfilePort } from "../customer/ports";
import { createProfilePort } from "../customer/profile";
installProfilePort(createProfilePort(), { default: true });

// NF-e comercial usa a mesma rota HTTP para a tela e para a proposta do bot.
// O recibo durável pertence ao ERP; o Coordinator da área não chama o cofre.
import { COM1_OPERATIONS } from "../erp/commercial-nfe/metadata.ts";
import { registerBinaryRoute, registerReadRoute, registerWriteRoute } from "./hooks";
import { ApiError } from "../types";
for (const operation of COM1_OPERATIONS) {
  const path = `erp-comercial-nfe/${operation.path}`;
  if (operation.method !== "GET") {
    registerWriteRoute({ method: operation.method, path, op: operation.name });
    continue;
  }
  const binary = ["com1.danfe", "com1.xml", "com1.cancel.xml"].includes(operation.name);
  if (binary) {
    registerBinaryRoute({ method: "GET", path, handler: async (env, actor, profile, request) => {
      const { commercialNfeRoute } = await import("../erp/commercial-nfe/routes.ts");
      const { createDefaultCommercialNfeHttp } = await import("../erp/commercial-nfe/http.ts");
      return commercialNfeRoute(env, request.request, profile, actor, { handle: createDefaultCommercialNfeHttp() });
    } });
  } else {
    registerReadRoute({ path, handler: async (env, actor, profile, request) => {
      const endpoint = operation.path.replace(":id", encodeURIComponent(request.params.id ?? ""));
      const url = new URL(`/api/v1/profiles/${encodeURIComponent(profile)}/erp-comercial-nfe/${endpoint}`, "https://wabotia.internal");
      for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, value);
      const { commercialNfeRoute } = await import("../erp/commercial-nfe/routes.ts");
      const { createDefaultCommercialNfeHttp } = await import("../erp/commercial-nfe/http.ts");
      const response = await commercialNfeRoute(env, new Request(url), profile, actor, { handle: createDefaultCommercialNfeHttp() });
      const result = await response.json() as { code?: string; message?: string };
      if (!response.ok) throw new ApiError(response.status, result.code ?? "fiscal_operation_failed", result.message ?? "Não foi possível consultar a emissão.");
      return result;
    } });
  }
}
