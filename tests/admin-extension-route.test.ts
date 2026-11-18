import { describe, expect, it } from "vitest";
import { waitingModules } from "../web/admin/AdminArea";
import { canOpenPage } from "../web/workspace-navigation";

// Na 0.22.0, abrir /app/gestao/condominio (favorito, F5) trocava o endereço
// por Início: o estado dos módulos ainda não tinha chegado.
describe("Gestão: páginas de extensão abertas pelo endereço", () => {
  it.each(["juridico", "condominio", "saude", "ensino"])("%s espera o estado dos módulos em vez de ir para Início", (page) => {
    const loading = canOpenPage(page, "admin", undefined, null);
    expect(loading).toBe(false);
    expect(waitingModules(page, undefined, loading)).toBe(true);
    const on = canOpenPage(page, "admin", { os: true, [page]: true }, null);
    expect(on).toBe(true);
    const off = canOpenPage(page, "admin", { os: true, [page]: false }, null);
    expect(waitingModules(page, { os: true, [page]: false }, off)).toBe(false);
  });

  it("página inexistente não espera", () => {
    expect(waitingModules("nao-existe", undefined, false)).toBe(false);
  });
});
