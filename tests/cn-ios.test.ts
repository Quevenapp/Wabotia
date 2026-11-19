import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_REGISTRY, channelRules, channelWindow } from "../src/channels";
import type { ChannelConnection, TranscriptPreview, TranscriptSendRequest } from "../src/channel-contracts";
import models from "../mobile/ios/Wabotia/Core/Models.swift?raw";
import channels from "../mobile/ios/Wabotia/Core/ChannelModels.swift?raw";
import endpoints from "../mobile/ios/Wabotia/Core/API/Endpoints.swift?raw";
import workspace from "../mobile/ios/Wabotia/Core/Workspace.swift?raw";
import list from "../mobile/ios/Wabotia/Features/Conversations/ConversationsView.swift?raw";
import listModel from "../mobile/ios/Wabotia/Features/Conversations/ConversationsViewModel.swift?raw";
import detail from "../mobile/ios/Wabotia/Features/Conversations/ConversationView.swift?raw";
import detailModel from "../mobile/ios/Wabotia/Features/Conversations/ConversationViewModel.swift?raw";
import info from "../mobile/ios/Wabotia/Features/Conversations/ConversationInfoView.swift?raw";
import email from "../mobile/ios/Wabotia/Features/Conversations/EmailTranscriptSheet.swift?raw";
import avatar from "../mobile/ios/Wabotia/Core/Theme/Components.swift?raw";
import demo from "../mobile/ios/Wabotia/Core/Demo/DemoServer.swift?raw";
import nativeTests from "../mobile/ios/WabotiaTests/ChannelsTests.swift?raw";
import demoTests from "../mobile/ios/WabotiaTests/ChannelsDemoTests.swift?raw";

// Vitest valida o contrato compartilhado e os encaixes de fonte. Não compila Swift,
// não executa XCTest e não substitui compilação/inspeção visual no Xcode, pendentes no Mac.
beforeEach(() => {
  // Não retornar o mock: o Vitest executa funções retornadas pelo hook como limpeza.
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Rede inesperada nos contratos iOS.");
  });
});
afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

const hour = 3_600_000;
const now = 1_800_000_000_000;
const connection: ChannelConnection = { id: "wa", profile_id: "demo", kind: "zernio", config: "{}" };

describe("cn-ios: contratos de canais (validação Swift pendente no Mac)", () => {
  it("conserva o contrato antigo e os campos adicionais opcionais", () => {
    for (const name of ["channel", "account_label", "multichannel", "window", "other_conversations", "email_transcript"])
      expect(models).toMatch(new RegExp(`var ${name}: [^\\n]+\\?`));
    expect(channels).toContain('external_namespace == "channel:\\(connection_id)"');
    expect(channels).toContain('connectionKind == "ai"');
    expect(channels).toContain('return "Canal desconhecido"');
    expect(channels).toContain('let rawValue: String');
    expect(nativeTests).toContain("testOldDTOStillDecodes");
    expect(nativeTests).toContain("testUnknownChannel");
  });

  it("mantém só WhatsApp sem selo/filtro extra e QR sem prazo", () => {
    expect(channelRules(connection)?.id).toBe("whatsapp");
    expect(channelRules({ ...connection, kind: "qr" })?.window.kind).toBe("none");
    expect(list).toContain("if workspace.showsChannelFilter");
    expect(channels).toContain("channelFilterOptions.count > 1");
    expect(avatar).toContain("multichannel");
    expect(workspace).toContain("conversation.resolvedChannel(connectionKind: lineKind)) == .whatsapp");
    expect(channels).toContain('if channel == .whatsapp');
  });

  it.each(["instagram", "facebook"] as const)("usa as duas etapas de janela de %s do contrato", channel => {
    const rules = { ...CHANNEL_REGISTRY[channel], enabled: true };
    const fixtures = [
      { age: 24 * hour - 1, state: "open", automation: true, human: true },
      { age: 24 * hour, state: "human_text_only", automation: false, human: true },
      { age: 25 * hour, state: "human_text_only", automation: false, human: true },
      { age: 168 * hour - 1, state: "human_text_only", automation: false, human: true },
      { age: 168 * hour, state: "closed", automation: false, human: false },
    ];
    for (const fixture of fixtures) {
      const state = channelWindow(rules, now - fixture.age, now);
      expect(state).toMatchObject({ state: fixture.state, canHumanText: fixture.human, canAutomation: fixture.automation });
      for (const name of Object.keys(state)) expect(channels).toContain(`var ${name}:`);
    }
    expect(channelWindow(rules, 0, now).canHumanText).toBe(false);
    expect(channels).toContain("max(now, serverNow)");
    expect(channels).toContain("current.canAutomation");
    expect(channels).toContain('feature == "reply"');
  });

  it("filtra antes de paginar, separa cache e descarta resposta atrasada", () => {
    expect(endpoints).toContain('"channel": channel?.rawValue');
    expect(listModel).toContain('let parts = [profile, channel?.rawValue ?? "", filter.rawValue, query]');
    expect(listModel).toContain("generation == loadGeneration");
    expect(listModel).toContain("selectedChannel == channel");
    expect(listModel).toContain("selectedFilter == filter");
    expect(listModel).toContain("selectionKey != key");
    expect(listModel).toContain("nextCursor = nil");
    expect(list.indexOf("if workspace.showsChannelFilter")).toBeLessThan(list.indexOf("            filters"));
  });

  it("usa DTOs A7 e exige confirmação explícita antes do envio", () => {
    const preview: TranscriptPreview = {
      recipient: "cliente@example.test", period: { from: now - hour, to: now },
      messageCount: 2, size: { textChars: 100, htmlChars: 160 }, warnings: [],
      requiresConfirmation: true, requiresCustomerRequest: true, previewToken: "synthetic", expiresAt: now + 600_000,
    };
    const send: TranscriptSendRequest = { previewToken: preview.previewToken, confirmedRecipient: preview.recipient, customerRequested: true };
    for (const name of [...Object.keys(preview), ...Object.keys(send)]) expect(channels).toContain(`var ${name}:`);
    expect(endpoints).toContain('/email/preview", body: body, key: key');
    expect(endpoints).toContain('/email", body: body, key: key');
    expect(email).toContain('destination == "contact" || preview?.requiresCustomerRequest == true');
    expect(email).toContain('destination != "self" || preview?.requiresConfirmation == true');
    expect(email).toContain("confirmedRecipient.trimmingCharacters");
    expect(email).toContain("guard canConfirm, let preview");
    expect(email).not.toContain("messageTag:");
  });

  it("preserva corpo e chave após falha e não reenvia resultado indeterminado", () => {
    expect(channels).toContain("previous.body == body");
    expect(email).toContain("attempt.body, key: attempt.key");
    expect(email).toContain("!indeterminate, result == nil");
    expect(email).toContain("result = response");
    expect(email).toContain("private static var drafts:");
    expect(email).toContain("container.session.token == sessionToken");
    expect(email).toContain("Consultar esta tentativa");
    expect(email).not.toMatch(/Task\.sleep|Timer\./);
  });

  it("ficha mostra apenas canais/históricos retornados e módulos obedecem canal", () => {
    expect(channels).toContain("guard resolvedChannel(fallbackKind: fallbackKind) == .whatsapp");
    expect(endpoints).toContain('/contacts/\\(id)/profile"');
    expect(detailModel).toContain("other_conversations");
    expect(info).toContain("vm.otherConversations");
    expect(info).toContain("channels");
    expect(info).not.toContain("/merge");
    expect(detailModel).toContain("modulesAllowed");
    expect(detail).toContain("EmailTranscriptSheet");
    expect(info).toContain("EmailTranscriptSheet");
  });

  it("declara demo sintética e prova nativa de repetição, sem chamadas externas", () => {
    for (const id of ["c_ig_open", "c_ig_human", "c_fb_closed"]) expect(demo).toContain(id);
    expect(demo).toContain("WABOTIA_DEMO_CHANNELS");
    expect(demo).toContain("idempotency_conflict");
    expect(demo).toContain("customerRequested");
    expect(demoTests).toContain("XCTestCase");
    expect(demoTests).toContain("duplicate");
    expect(demoTests).toContain("Idempotency-Key");
    expect(demoTests).not.toContain("URLSession.shared");
    for (const id of ["tiktok", "googlebusiness", "telegram", "email"] as const) {
      expect(CHANNEL_REGISTRY[id].enabled).toBe(false);
      expect(channels).toContain(`rawValue: "${id}"`);
    }
  });
});
