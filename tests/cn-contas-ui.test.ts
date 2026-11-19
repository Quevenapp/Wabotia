import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAccountView } from "../src/channel-contracts";
import { ChannelAccountChoices, channelAccountReason, NumberRouter } from "../web/NumberRouter";
import { ConnectionDialog, connectionChannelPresentation, connectionFormConfiguration } from "../web/admin/ConnectionDialog";
import { connectionKindLabel, isPhoneConnection } from "../web/admin/ConnectionsPage";
import { LineCard, LineChoices, menuLinesForType, serviceLinePresentation } from "../web/ServicePanels";

const runtime = vi.hoisted(() => ({ api: vi.fn(() => { throw Error("Chamada inesperada à API"); }) }));
vi.mock("../web/app/AppContext", () => ({ useApp: () => ({ api: runtime.api, root: "v1/profiles/area", demoBlocked: () => false }) }));
// O portal só transporta o diálogo para o DOM. Os campos e estados são reais.
vi.mock("../web/admin/shared", async (original) => ({
  ...(await original<typeof import("../web/admin/shared")>()),
  FormDialog: ({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) =>
    React.createElement("form", null, children, React.createElement("button", { disabled }, "Salvar")),
}));

const wa = { id: "wa", name: "Atendimento", kind: "zernio", number: "5511999990001", status: "active" };
const ig = { id: "ig", name: "Loja", kind: "zernio", channel: "instagram", account_label: "@loja", status: "paused",
  account_id: "conta-opaca", zernio_workspace_id: "integracao", zernio_profile_id: "perfil-remoto" };
const props = { api: runtime.api, root: "v1/profiles/area", demo: false, bots: [], refresh: async () => {} };
const account = (extra: Partial<ChannelAccountView> = {}): ChannelAccountView => ({
  integrationId: "integracao", channel: "instagram", accountId: "conta-opaca", providerProfileId: "perfil-remoto",
  accountLabel: "@loja", connectionId: null, importable: true, reason: null, ...extra,
});
const html = (element: React.ReactElement) => renderToStaticMarkup(element);
beforeEach(() => {
  runtime.api.mockClear();
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Rede inesperada no teste de contas"); }));
  vi.stubGlobal("location", { origin: "https://wabotia.invalid" });
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  expect(runtime.api).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("cn-contas: conexão por canal", () => {
  it("só WhatsApp conserva formulário, configuração e apresentação de telefone", () => {
    const markup = html(React.createElement(ConnectionDialog, { initial: wa, onClose() {}, onSaved() {} }));
    expect(markup).toContain("Telefone com DDI (somente dígitos)");
    expect(markup).toContain("ID do telefone na Zernio");
    expect(markup).toContain("Este número tem grupos empresariais");
    expect(markup).not.toContain("inbox_required");
    expect(html(React.createElement(ConnectionDialog, { initial: { ...wa, channel: "whatsapp" }, onClose() {}, onSaved() {} }))).toBe(markup);
    expect(connectionKindLabel(wa)).toBe("WhatsApp pela Zernio");
    expect(isPhoneConnection(wa)).toBe(true);
    expect(connectionFormConfiguration({ ...wa, groups_enabled: true, api_key: "secret" }))
      .toEqual({ config: { number: wa.number, groups_enabled: true }, secrets: { api_key: "secret" } });
  });

  it.each(["instagram", "facebook"])("%s não oferece telefone, grupo, segredo ou edição da identidade importada", (channel) => {
    const form = { ...ig, channel, number: "telefone-injetado", groups_enabled: true, api_key: "nao-copiar" };
    const markup = html(React.createElement(ConnectionDialog, { initial: form, onClose() {}, onSaved() {} }));
    expect(markup).not.toContain("Telefone com DDI");
    expect(markup).not.toContain("ID do telefone");
    expect(markup).not.toContain("type=\"password\"");
    expect(markup).not.toContain("grupos empresariais");
    expect(markup).toContain("Canal, conta e integração são fixos");
    expect(markup).toContain("inbox_required");
    expect(markup).toContain("somente texto escrito por uma pessoa");
    expect(isPhoneConnection(form)).toBe(false);
    expect(connectionFormConfiguration(form)).toEqual({ config: {
      account_id: ig.account_id, zernio_profile_id: ig.zernio_profile_id, zernio_workspace_id: ig.zernio_workspace_id,
    }, secrets: {} });
  });

  it("criação social manual e canais futuros continuam indisponíveis", () => {
    for (const initial of [{ ...ig, id: undefined }, { ...ig, channel: "tiktok" }, { ...ig, channel: "googlebusiness" }]) {
      const markup = html(React.createElement(ConnectionDialog, { initial, onClose() {}, onSaved() {} }));
      expect(markup).toContain("<button disabled=\"\">Salvar</button>");
      expect(markup).not.toContain("Telefone com DDI");
    }
    expect(connectionChannelPresentation({ kind: "ai", channel: "whatsapp" }).channel).toBeNull();
    expect(connectionChannelPresentation({ kind: "zernio", channel: "desconhecido" }).available).toBe(false);
  });
});

describe("cn-contas: descoberta dentro da integração", () => {
  it("mantém a etapa telefônica e acrescenta busca social sem mudar cotas ou distribuição", () => {
    const markup = html(React.createElement(NumberRouter, { api: runtime.api, root: props.root, demo: true }));
    expect(markup).toContain("WhatsApp da sua empresa");
    expect(markup).toContain("Telefones");
    expect(markup).toContain("Distribuição");
    expect(markup).toContain("Buscar contas na Zernio");
    expect(markup).toContain("Buscar telefones");
  });

  it("conta sem telefone pode ser importada; repetida mostra a conexão já importada", () => {
    const first = html(React.createElement(ChannelAccountChoices, { accounts: [account()], busy: false, onImport() {} }));
    expect(first).toContain("Instagram · @loja");
    expect(first).toContain("Importar conta");
    expect(first).not.toContain("<input");
    expect(first).not.toContain("conta-opaca");
    const repeated = html(React.createElement(ChannelAccountChoices, { accounts: [account({ connectionId: "ig", importable: false })], busy: false, onImport() {} }));
    expect(repeated).toContain("Conexão já importada");
    expect(repeated).not.toContain("Importar conta");
  });

  it("explica erro de plano e não habilita canais da próxima etapa", () => {
    const markup = html(React.createElement(ChannelAccountChoices, { accounts: [
      account({ importable: false, reason: "inbox_required" }),
      account({ channel: "googlebusiness", accountId: "google", importable: true }),
    ], warnings: ["a conferir com a conta real"], busy: false, onImport() {} }));
    expect(markup).toContain(channelAccountReason("inbox_required"));
    expect(markup.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(markup).toContain("próxima etapa");
  });
});

describe("cn-contas: linhas e capacidades", () => {
  it("só WhatsApp conserva número e política do roteador, sem avisos sociais", () => {
    const markup = html(React.createElement(LineCard, { ...props, line: wa }));
    expect(markup).toContain("+5511999990001");
    expect(markup).not.toContain("Até 7 dias");
    expect(html(React.createElement(LineCard, { ...props, line: { ...wa, channel: "whatsapp" } }))).toBe(markup);
    expect(serviceLinePresentation(wa)).toMatchObject({ available: true, channel: "whatsapp", modules: true });
    expect(menuLinesForType([wa], "pedido")).toEqual([wa]);
  });

  it("linha social usa nome da conta, bot, menu e janela sem cota telefônica", () => {
    const markup = html(React.createElement(LineCard, { ...props, line: { ...ig, number: "não-exibir" } }));
    expect(markup).toContain("Instagram · @loja");
    expect(markup).not.toContain("não-exibir");
    expect(markup).not.toContain("Número não informado");
    expect(markup).toContain("Bot específico");
    expect(markup).toContain("13 respostas rápidas");
    expect(markup).toContain("Até 7 dias, somente texto escrito pela equipe");
    expect(markup).not.toContain("Salvar função e permissões");
    expect(menuLinesForType([wa, ig], "pedido")).toEqual([wa]);
    expect(menuLinesForType([wa, ig], "protocols")).toEqual([wa, ig]);
  });

  it("Google não é linha, futuros e desconhecidos não ganham formulário utilizável", () => {
    for (const channel of ["googlebusiness", "tiktok", "telegram", "email", "desconhecido"]) {
      const line = { ...ig, channel };
      expect(serviceLinePresentation(line).available).toBe(false);
      expect(html(React.createElement(LineCard, { ...props, line }))).toBe("");
      expect(menuLinesForType([line], "content")).toEqual([]);
    }
    const markup = html(React.createElement(LineChoices, { lines: [wa, ig, { ...ig, id: "google", channel: "googlebusiness" }], value: [], onChange() {} }));
    expect(markup).toContain("Instagram");
    expect(markup).not.toContain("Google");
    expect(serviceLinePresentation({ ...ig, serviceLine: false }).available).toBe(false);
    expect(serviceLinePresentation({ ...ig, capabilities: { bot: false } }).bot).toBe(false);
    expect(serviceLinePresentation({ ...wa, kind: "ai", channel: "whatsapp" }).available).toBe(false);
  });
});
