import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContactMergePreview, ContactMergeRequest, ContactMergeResult, CustomerChannelView } from "../src/channel-contracts";
import { ChannelsSection, hasSocialChannels } from "../web/contact-profile/ChannelsSection";
import { MergePreviewDetails } from "../web/contact-profile/MergeContactsDialog";
import { contactMergeWriter, contactsQuery, profileMessage, ProfileRequests, validMergePreview } from "../web/contact-profile/model";

// Os componentes puros não precisam carregar a casca e seus transportes.
vi.mock("../web/ContactsPanel", () => ({ Dialog: ({ children }: { children: React.ReactNode }) => children }));
beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Rede inesperada no teste de identidade."); })));
afterEach(() => vi.unstubAllGlobals());

const channel = (extra: Partial<CustomerChannelView> = {}): CustomerChannelView => ({
  id: "local-identity", channel: "instagram", account_label: "@loja", display_name: "Ana", username: "@ana",
  state: "ready", connection_id: "connection", subject_masked: "••••1234", ...extra,
});
const preview = (extra: Partial<ContactMergePreview> = {}): ContactMergePreview => ({
  source: { id: "social", version: 2, name: "Ana", phone: null, email: "", document: null, erpId: null },
  target: { id: "erp", version: 7, name: "Ana Silva", phone: "5511988880000", email: "ana@example.com", document: null, erpId: "erp-1" },
  survivorId: "erp", differences: [{ field: "name", source: "Ana", target: "Ana Silva", defaultChoice: "target", requiresConfirmation: true }],
  relationCounts: { conversation_contacts: 2, customer_channel_ids: 1 }, blockers: [], previewToken: "signed-preview", expiresAt: 123456789,
  ...extra,
});
const input = (): ContactMergeRequest => ({ targetId: "erp", sourceVersion: 2, targetVersion: 7, previewToken: "signed-preview", fieldChoices: {} });
const result = (extra: Partial<ContactMergeResult> = {}): ContactMergeResult => ({
  id: "merge-1", sourceId: "social", targetId: "erp", sourceVersion: 3, targetVersion: 8, state: "applied", duplicate: false, ...extra,
});

describe("ficha de canais e compatibilidade", () => {
  it("só WhatsApp mantém a ficha sem uma seção, conta ou selo novos", () => {
    const channels = [channel({ channel: "whatsapp" })];
    expect(hasSocialChannels(undefined)).toBe(false);
    expect(hasSocialChannels(channels)).toBe(false);
    expect(renderToStaticMarkup(React.createElement(ChannelsSection, { channels }))).toBe("");
    expect(new URLSearchParams(contactsQuery({ identity: "phone_only" })).get("identity")).toBe("phone_only");
  });
  it("mostra canais, conta empresarial e situação sem identificador opaco", () => {
    const social = { ...channel(), subject_id: "secret-opaque-subject", account_id: "secret-account-id" };
    const html = renderToStaticMarkup(React.createElement(ChannelsSection, { channels: [social, channel({ id: "wa", channel: "whatsapp" })] }));
    expect(html).toContain("Canais"); expect(html).toContain("Instagram"); expect(html).toContain("WhatsApp");
    expect(html).toContain("Conta empresarial: @loja"); expect(html).toContain("Verificado neste canal");
    expect(html).not.toContain("secret-opaque-subject"); expect(html).not.toContain("secret-account-id");
    expect(html).not.toContain("local-identity");
  });
  it("exibe somente conversas devolvidas e escapa a apresentação", () => {
    const html = renderToStaticMarkup(React.createElement(ChannelsSection, { channels: [channel({ display_name: "<script>alert(1)</script>" })],
      conversations: [{ id: "allowed/id", channel: "facebook", account_label: "Loja", title: "Conversa autorizada", state: "waiting", updated: 1 }] }));
    expect(html).toContain("/app/conversas/allowed%2Fid"); expect(html).not.toContain("<script>");
    expect(html).not.toContain("subject_id"); expect(fetch).not.toHaveBeenCalled();
  });
  it("filtro novo convive com alias legado e revisão telefônica", () => {
    expect(new URLSearchParams(contactsQuery({ identity: "no_personal_data" })).get("identity")).toBe("no_personal_data");
    expect(new URLSearchParams(contactsQuery({ identity: "no_personal_data", review: true })).get("identity")).toBe("phone_only");
  });
});

describe("prévia humana e sobrevivente ERP", () => {
  it("não presume equivalência por nome: exige par, versões e token do servidor", () => {
    expect(validMergePreview(preview(), "social", "erp")).toBe(true);
    for (const value of [preview({ source: { ...preview().source, id: "outra" } }), preview({ survivorId: "outro" }),
      preview({ previewToken: "" }), preview({ target: { ...preview().target, version: 0 } })])
      expect(validMergePreview(value, "social", "erp")).toBe(false);
    expect(validMergePreview(preview(), "social", "social")).toBe(false);
  });
  it("marca ERP como sobrevivente e mostra substituição explícita lado a lado", () => {
    const html = renderToStaticMarkup(React.createElement(MergePreviewDetails, { preview: preview(), choices: {}, onChoice: vi.fn() }));
    expect(html).toContain("Ficha de origem"); expect(html).toContain("Outra ficha");
    expect(html).toContain("Ficha que será mantida"); expect(html).toContain("Vinculada ao ERP");
    expect(html).toContain('value="target" selected=""'); expect(html).toContain("Valores diferentes");
    expect(html).not.toContain("erp-1"); expect(html).toContain("Conversas: 2");
  });
  it("exibe impedimentos de ERP, restrição e alteração sem oferecer fusão remota", () => {
    const html = renderToStaticMarkup(React.createElement(MergePreviewDetails, { preview: preview({ blockers: [
      { code: "merge_erp_conflict", message: "Dois vínculos ERP diferentes." }, { code: "merge_restricted", message: "Contato restrito." },
    ] }), choices: {}, onChoice: vi.fn() }));
    expect(html).toContain("Dois vínculos ERP diferentes."); expect(html).toContain("Contato restrito.");
    expect(profileMessage({ code: "merge_changed" })).toContain("não pode ser desfeita");
  });
});

describe("comandos de junção e desfazer", () => {
  it("timeout conserva comando e corpo; edição explícita gera outra chave", async () => {
    const api = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue(result());
    const writer = contactMergeWriter(api, "v1/profiles/area/contacts/social");
    await expect(writer.merge(input())).rejects.toThrow("timeout");
    await writer.merge(input());
    expect(api.mock.calls[1]).toEqual(api.mock.calls[0]);
    await writer.merge({ ...input(), fieldChoices: { name: "source" } });
    expect(api.mock.calls[2][4]).not.toBe(api.mock.calls[1][4]);
    expect(api.mock.calls[0][2]).toEqual(input());
    expect(api.mock.calls[0][2]).not.toHaveProperty("verifiedPhone");
  });
  it("aceita inversão ERP e recusa resultado de outro par", async () => {
    const api = vi.fn().mockResolvedValueOnce(result({ sourceId: "erp", targetId: "social" }))
      .mockResolvedValueOnce(result({ sourceId: "erp", targetId: "other" }));
    const writer = contactMergeWriter(api, "v1/profiles/area/contacts/social");
    expect((await writer.merge(input())).targetId).toBe("social");
    await expect(writer.merge(input())).rejects.toThrow("confirmar a junção");
  });
  it("desfazer possui outra chave estável e mantém a verificação no servidor", async () => {
    const api = vi.fn().mockResolvedValueOnce(result()).mockRejectedValueOnce(Object.assign(new Error("conversa mudou"), { code: "merge_changed" }))
      .mockResolvedValue(result({ state: "undone" }));
    const writer = contactMergeWriter(api, "v1/profiles/area/contacts/social"), body = { mergeId: "merge-1" };
    await writer.merge(input());
    await expect(writer.undo(body)).rejects.toMatchObject({ code: "merge_changed" });
    await writer.undo(body);
    expect(api.mock.calls[2]).toEqual(api.mock.calls[1]);
    expect(api.mock.calls[1][4]).not.toBe(api.mock.calls[0][4]);
    expect(api.mock.calls[1][0]).toBe("v1/profiles/area/contacts/social/merges/merge-1/undo");
  });
  it("troca de alvo e descarte invalidam respostas concorrentes", () => {
    const requests = new ProfileRequests(), old = requests.begin("preview"), next = requests.begin("preview");
    expect(old.current()).toBe(false); expect(next.current()).toBe(true);
    requests.dispose(); expect(next.current()).toBe(false);
  });
});
