import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_REGISTRY, assertChannelSend, channelRules, channelWindow } from "../src/channels";
import type { ChannelConnection, ChannelId, ChannelSpec, SendOrigin } from "../src/channel-contracts";
import models from "../mobile/android/app/src/main/java/br/com/queven/wabotia/core/model/Models.kt?raw";
import channelModels from "../mobile/android/app/src/main/java/br/com/queven/wabotia/core/model/ChannelModels.kt?raw";
import api from "../mobile/android/app/src/main/java/br/com/queven/wabotia/core/net/WabotiaApi.kt?raw";
import listVm from "../mobile/android/app/src/main/java/br/com/queven/wabotia/ui/conversations/ConversationsViewModel.kt?raw";
import listScreen from "../mobile/android/app/src/main/java/br/com/queven/wabotia/ui/conversations/ConversationsScreen.kt?raw";
import detailVm from "../mobile/android/app/src/main/java/br/com/queven/wabotia/ui/conversations/ConversationViewModel.kt?raw";
import detailScreen from "../mobile/android/app/src/main/java/br/com/queven/wabotia/ui/conversations/ConversationScreen.kt?raw";
import infoScreen from "../mobile/android/app/src/main/java/br/com/queven/wabotia/ui/conversations/ConversationInfoScreen.kt?raw";
import composer from "../mobile/android/app/src/main/java/br/com/queven/wabotia/ui/conversations/Composer.kt?raw";
import emailSheet from "../mobile/android/app/src/main/java/br/com/queven/wabotia/ui/conversations/EmailTranscriptSheet.kt?raw";
import avatar from "../mobile/android/app/src/main/java/br/com/queven/wabotia/ui/components/Avatar.kt?raw";
import windowSource from "../mobile/android/app/src/main/java/br/com/queven/wabotia/ui/components/Window.kt?raw";
import push from "../mobile/android/app/src/main/java/br/com/queven/wabotia/core/push/WabotiaMessagingService.kt?raw";
import notifications from "../mobile/android/app/src/main/java/br/com/queven/wabotia/core/push/Notifications.kt?raw";
import demoData from "../mobile/android/app/src/main/java/br/com/queven/wabotia/demo/DemoData.kt?raw";
import demoServer from "../mobile/android/app/src/main/java/br/com/queven/wabotia/demo/DemoServer.kt?raw";
import nativeModels from "../mobile/android/app/src/test/java/br/com/queven/wabotia/core/model/ChannelModelsTest.kt?raw";
import nativeDemo from "../mobile/android/app/src/test/java/br/com/queven/wabotia/demo/ChannelsDemoTest.kt?raw";
import androidCheck from "../scripts/cn-android-check.mjs?raw";

// Vitest verifica contratos puros do servidor e os pontos de integração das fontes Android.
// O comportamento Kotlin é executado por :app:testDebugUnitTest, não por estas leituras ?raw.
beforeEach((): void => {
  // Retornar o spy faria o Vitest chamá-lo como limpeza do hook, simulando uma chamada à rede.
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Rede inesperada na verificação Android.");
  });
});
afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const connection = (kind: string, channel?: ChannelId): ChannelConnection => ({
  id: "demo-connection", profile_id: "demo-profile", kind, channel, config: "{}",
});
const socialRules = (channel: "instagram" | "facebook"): ChannelSpec => ({ ...CHANNEL_REGISTRY[channel], enabled: true });

describe("cn-android: contrato consumido pelo aplicativo", () => {
  it("conserva WhatsApp oficial/QR e não transforma origem desconhecida em WhatsApp", () => {
    expect(channelRules(connection("zernio"))).toMatchObject({ id: "whatsapp", templates: true });
    expect(channelRules(connection("qr"))?.window).toEqual({ kind: "none" });
    expect(channelRules(connection("ai"))).toBeNull();
    expect(channelRules(connection("internal"))).toBeNull();
    expect(channelModels).toContain("channel ?: when (connectionKind)");
    expect(channelModels).toContain('else -> "Canal desconhecido"');
    expect(models).toContain("val channel: String? = null");
    expect(models).toContain("val multichannel: Boolean = false");
    expect(nativeModels).toContain("legacyAndUnknownChannelsNeverBecomeWhatsAppByExclusion");
  });

  it.each(["instagram", "facebook"] as const)("reproduz as três etapas das fixtures de %s", channel => {
    const rules = socialRules(channel);
    expect(channelWindow(rules, NOW - HOUR, NOW)).toMatchObject({ state: "open", canAutomation: true, canHumanText: true });
    expect(channelWindow(rules, NOW - 25 * HOUR, NOW)).toMatchObject({ state: "human_text_only", canAutomation: false, canHumanText: true });
    expect(channelWindow(rules, NOW - 168 * HOUR, NOW)).toMatchObject({ state: "closed", canAutomation: false, canHumanText: false });
    expect(() => assertChannelSend({ rules, window: channelWindow(rules, NOW - 25 * HOUR, NOW), origin: "manual_text", contentType: "text", hasAttachments: false })).not.toThrow();
    for (const origin of ["bot", "automation", "human_media"] as SendOrigin[]) {
      expect(() => assertChannelSend({ rules, window: channelWindow(rules, NOW - 25 * HOUR, NOW), origin, contentType: "text", hasAttachments: origin === "human_media" })).toThrow();
    }
  });

  it("declara canais futuros sem habilitar contas nem envios", () => {
    for (const channel of ["tiktok", "googlebusiness", "telegram", "email"] as const) {
      expect(CHANNEL_REGISTRY[channel].enabled).toBe(false);
      expect(channelModels).toContain(`"${channel}"`);
      expect(demoServer).toContain(`"${channel}"`);
    }
    expect(demoServer).toContain('"enabled" to false');
  });
});

describe("cn-android: integração de API, estado e telas", () => {
  it("isola a biblioteca Android já instalada antes de iniciar o wrapper offline", () => {
    expect(androidCheck).toContain("kit = stageThermalPrinterKit(kit, work)");
    expect(androidCheck).toContain("THERMAL_PRINTER_KIT_DIR: resolve(kit)");
    expect(androidCheck).toContain("-PthermalPrinterKitDir=${kitPath}");
    expect(androidCheck).toContain("['--offline', ':app:assembleDebug', ':app:testDebugUnitTest']");
    expect(androidCheck).toContain("-Pandroid.builder.sdkDownload=false");
    expect(androidCheck).toContain("if (!inside(workspace, work)) throw");
    expect(androidCheck).toContain("if (!inside(sourceRoot, path)) throw");
    expect(androidCheck).toContain("assert.equal(statSync(sourceFile).mtimeMs, before)");
    expect(androidCheck).toContain("cachedDistribution(sourceHome, distName, distHash)");
    expect(androidCheck).toContain("ANDROID_HOME: localSdk");
    expect(androidCheck).toContain("delete env.GRADLE_RO_DEP_CACHE");
  });

  it("canal integra requisição, chave de página e descarte de respostas atrasadas", () => {
    expect(api).toContain('@Query("channel") channel: String? = null');
    expect(listVm).toContain("ConversationPageKey(profileId, filter.state, appliedQuery.trim(), channel)");
    expect(listVm).toMatch(/fun selectChannel[\s\S]*?nextCursor = null[\s\S]*?load\(reset = true/);
    expect(listVm).toContain("channel = requestedKey.channel");
    expect(listVm).toContain("gen != generation || requestedKey != pageKey");
    expect(listVm.indexOf("gen != generation || requestedKey != pageKey")).toBeLessThan(listVm.indexOf("collected +="));
    expect(listScreen).toContain("conversationChannels.size > 1");
    expect(nativeDemo).toContain("channelsAreSeparateAndFilteredBeforePagination");
  });

  it("preserva estado/avatar do WhatsApp isolado e usa a janela devolvida", () => {
    expect(channelModels).toContain("multichannel && !channel.isNullOrBlank()");
    expect(avatar).toContain("if (showChannel) Alignment.TopEnd else Alignment.BottomEnd");
    expect(avatar).toContain("ChannelBadge(channel, Modifier.align(Alignment.BottomEnd)");
    expect(detailScreen).toContain("conversation.multichannel || conversation.channel != null && conversation.channel != \"whatsapp\"");
    expect(windowSource).toContain('window.kind == "none"');
    expect(windowSource).toContain("humanTextClosesAt");
    expect(windowSource).toContain('c.channel != null && c.channel != "whatsapp"');
    expect(detailVm).toContain("current.replyBlockReason");
    expect(channelModels).toContain("window.blockReason");
    expect(nativeModels).toContain("replyWindowKeepsWhatsappQueueAndGuardsSocialSending");
    expect(composer).toContain("Responder pelo");
    expect(nativeDemo).toContain("whatsappOnlyKeepsLegacyPresentationAndAnOptionalEmailAction");
  });

  it("lê a ficha e mantém outros diálogos separados, sem rota de junção", () => {
    expect(api).toContain('@GET("api/v1/profiles/{p}/contacts/{id}/profile")');
    expect(models).toContain("val other_conversations: List<OtherChannelConversation> = emptyList()");
    expect(infoScreen).toContain("channelProfile.channels");
    expect(infoScreen).toContain("OtherConversationsNotice");
    expect(api).not.toMatch(/@POST\([^\n]*\/merge/);
    expect(nativeDemo).toContain("contactChannelsAndOtherDialogsStaySeparate");
  });

  it("conecta prévia, confirmação e envio mantendo a mesma chave enquanto a tentativa não termina", () => {
    expect(api).toContain('@POST("api/v1/profiles/{p}/conversations/{id}/email/preview")');
    expect(api).toContain('@POST("api/v1/profiles/{p}/conversations/{id}/email")');
    expect(detailVm).toContain("container.api.emailPreview(profileId, conversationId, request)");
    expect(detailVm).toContain("container.api.sendEmailTranscript(profileId, conversationId, attempt.key, attempt.request)");
    expect(channelModels).toContain("pending ?: TranscriptPending(newKey(), request)");
    expect(channelModels).toContain("if (pending != null && !isTerminal) return false");
    expect(emailSheet).toContain("preview.requiresCustomerRequest");
    expect(emailSheet).toContain("preview.canConfirm");
    expect(emailSheet).toContain("Resultado indeterminado");
    expect(nativeDemo).toContain("transcriptRequiresConfirmationAndRepeatsWithoutAnotherEmailOrNote");
    expect(nativeModels).toContain("TranscriptAttempt()");
  });

  it("usa o título pronto do push e conserva os canais de notificação Android", () => {
    expect(push).toContain("Notifications.presentation(message.notification?.title, data)");
    expect(notifications).toContain('channel = data["channel"]');
    expect(notifications).toContain('const val CHANNEL_MESSAGES = "messages"');
    expect(notifications).toContain('const val CHANNEL_QUEUE = "queue"');
    expect(notifications).toContain('const val CHANNEL_TICKETS = "tickets"');
    expect(notifications).toContain("val channel = channelFor(type)");
    expect(notifications).not.toContain("Channels.label");
    expect(nativeDemo).toContain("pushUsesReadyTitleAndKeepsAndroidNotificationChannel");
  });

  it("mantém fixtures locais separadas, deduplica eventos e falha se um teste escapar à rede", () => {
    expect(demoData).toContain('const val PROFILE = "demo-profile"');
    expect(demoData).toContain('const val CHANNEL_PROFILE = "demo-channels"');
    expect(demoData).toContain('direct(Ids.C_FACEBOOK, "facebook", 25.0');
    expect(demoData).toContain('direct(Ids.C_SOCIAL_CLOSED, "instagram", 168.0');
    expect(demoData).toContain('list.firstOrNull { it.str("id") == messageId }?.let { return it }');
    expect(demoServer).toContain('it.str("direction") in setOf("customer", "outbound")');
    expect(demoServer).toContain('"duplicate" to true');
    expect(nativeDemo).toContain("Chamada inesperada à rede");
    expect(nativeDemo).toContain("repeatedEventsAndCommandsProduceOneMessage");
    expect(nativeDemo).toContain("unavailableUnauthorizedAndRevokedTranscriptRemainBlocked");
  });
});
