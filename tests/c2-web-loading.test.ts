import { beforeEach, describe, expect, it, vi } from "vitest";

const installation = vi.hoisted(() => ({ install: vi.fn() }));
vi.mock("../web/c2/register", () => ({ installC2Web: installation.install }));

beforeEach(() => {
  vi.resetModules();
  installation.install.mockReset();
});

describe("canais opcionais no pacote do painel", () => {
  it("não carrega a extensão para uma área só de WhatsApp e mensagens diretas da Meta", async () => {
    const { loadChannelUi } = await import("../web/channel-ui-loader");
    await loadChannelUi({ connected_channels: ["whatsapp", "instagram", "facebook"] }, "");
    expect(installation.install).not.toHaveBeenCalled();
  });

  it.each([
    [{ connected_channels: ["telegram"] }, ""],
    [{ connections: [{ channel: "instagram", config: { comments_enabled: true } }] }, ""],
    [{}, "?canais=2"],
  ])("instala antes de liberar a área ou o catálogo e reúne carregamentos simultâneos (%j)", async (status, search) => {
    const { loadChannelUi } = await import("../web/channel-ui-loader");
    await Promise.all([loadChannelUi(status, search), loadChannelUi(status, search)]);
    expect(installation.install).toHaveBeenCalledTimes(1);
    await loadChannelUi(status, search);
    expect(installation.install).toHaveBeenCalledTimes(1);
  });

  it("permite repetir a abertura quando o carregamento não pôde concluir", async () => {
    const { loadChannelUi } = await import("../web/channel-ui-loader");
    installation.install.mockImplementationOnce(() => { throw new Error("carregamento interrompido"); });
    await expect(loadChannelUi({ c2_active: true }, "")).rejects.toThrow("carregamento interrompido");
    await loadChannelUi({ c2_active: true }, "");
    expect(installation.install).toHaveBeenCalledTimes(2);
  });
});
