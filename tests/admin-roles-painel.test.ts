import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminRoles } from "../web/admin/UsersPage";

// Na 0.22.0 o painel não deixava conceder papéis de módulo a um administrador
// ("O administrador acessa tudo"), mas o servidor exige a concessão explícita
// (os:sensitive, condomínio, prontuário, ensino, jurídico) também para ele.
describe("Pessoas e acessos: papéis explícitos do administrador", () => {
  const catalog = {
    presets: [],
    data: [
      { id: "os", label: "Ordem de Serviço", group: "module" },
      { id: "os:sensitive", label: "Dados sensíveis", role: true, module_id: "os" },
      { id: "condominio", label: "Condomínio", group: "module" },
      { id: "condominio:admin", label: "Administração do condomínio", role: true, module_id: "condominio" },
    ],
  };

  it("lista só os papéis, com o módulo, e marca os concedidos", () => {
    const html = renderToStaticMarkup(
      React.createElement(AdminRoles, { catalog, value: ["condominio:admin"], onChange: () => {} }),
    );
    expect(html).toContain("Ordem de Serviço: Dados sensíveis");
    expect(html).toContain("Condomínio: Administração do condomínio");
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).not.toContain(">Condomínio</label>");
  });

  it("sem papéis no catálogo mantém o aviso de acesso total", () => {
    const html = renderToStaticMarkup(
      React.createElement(AdminRoles, { catalog: { presets: [], data: [{ id: "os", label: "OS" }] }, value: [], onChange: () => {} }),
    );
    expect(html).toContain("O administrador acessa tudo.");
  });
});
