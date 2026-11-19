import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessCatalog, accessPresets, allows, effectiveAccess, rolesOf, validateAccess } from "../src/access";
import type { Actor } from "../src/types";
import { AccessEditor, toggleAccess } from "../web/admin/UsersPage";
import { ApplicationScopes, applicationScopes, toggleApplicationScope } from "../web/admin/ApplicationsPage";
import { EmailLog, EmailSection, TranscriptEmailSettings } from "../web/EmailSection";

const person = (access: string[] | null = null, extra: Partial<Actor> = {}): Actor => ({
  id: "person", kind: "user", role: "operator", name: "Pessoa", profiles: ["area"],
  scopes: [], bots: [], rate: 60, runLimit: 1, access, ...extra,
});
const catalog = { data: accessCatalog({}), presets: [{ id: "full", label: "Atendente completo", access: ["*"] }] };
const noop = () => {};
beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Rede inesperada"); })));
afterEach(() => vi.unstubAllGlobals());

describe("permissões explícitas de transcrição e junção", () => {
  it("só WhatsApp mantém o atendimento antigo; '*' não acrescenta exportação nem junção", () => {
    expect(effectiveAccess({ kind: "user", role: "operator", access: null } as Actor, catalog.data))
      .not.toContain("conversations:email");
    for (const access of [null, ["*"]]) {
      const actor = person(access);
      expect(allows(actor, "conversations")).toBe(true);
      expect(allows(actor, "contacts")).toBe(true);
      for (const id of ["conversations:email", "contacts:merge"]) {
        expect(allows(actor, id)).toBe(false);
        expect(effectiveAccess(actor, catalog.data)).not.toContain(id);
      }
    }
    for (const item of catalog.data.filter((item) => item.explicitOnly)) {
      expect(item.group).toBe("core");
      expect(item.role).toBe(false);
    }
    for (const preset of accessPresets) {
      expect([...preset.access]).not.toContain("conversations:email");
      expect([...preset.access]).not.toContain("contacts:merge");
    }
  });

  it("concessão explícita não vira papel de módulo nem acesso de leitura à conversa ou ficha", () => {
    const actor = person(["conversations:email", "contacts:merge"]);
    expect(validateAccess(actor.access)).toEqual(actor.access);
    expect(allows(actor, "conversations:email")).toBe(true);
    expect(allows(actor, "contacts:merge")).toBe(true);
    expect(allows(actor, "conversations")).toBe(false);
    expect(allows(actor, "contacts")).toBe(false);
    expect(rolesOf(actor)).toEqual([]);
    expect(effectiveAccess(actor, catalog.data)).toEqual(["conversations:email", "contacts:merge"]);
    expect(rolesOf(person(["*", "conversations:email", "os:technician"]))).toEqual(["os:technician"]);
  });

  it("administrador inicia autorizado; aplicações reais precisam de escopo exato e nunca juntam", () => {
    const admin = person([], { role: "admin" });
    expect(allows(admin, "conversations:email")).toBe(true);
    expect(allows(admin, "contacts:merge")).toBe(true);
    expect(effectiveAccess(admin, catalog.data)).toContain("contacts:merge");
    const app = person(null, { kind: "app", role: "service", id: "app:app", scopes: ["*"] });
    expect(allows(app, "conversations:email")).toBe(false);
    expect(effectiveAccess(app, catalog.data)).not.toContain("conversations:email");
    app.scopes = ["conversations:read", "conversations:email", "contacts:merge"];
    expect(allows(app, "conversations:email")).toBe(true);
    expect(allows(app, "contacts:merge")).toBe(false);
    expect(effectiveAccess(app, catalog.data)).not.toContain("contacts:merge");
  });

  it("bot, delegação, conector e credencial de módulo não recebem as permissões", () => {
    for (const extra of [
      { role: "service" as const },
      { kind: "connector" as const },
      { kind: "app" as const, id: "bot:automation", scopes: ["conversations:email"] },
      { kind: "app" as const, scopes: ["conversations:bound", "conversations:email"] },
      { via: { kind: "bot" as const, bot_id: "b", run_id: "r", masked: true } },
      { module: { id: "forms", reach: [] } },
      { credential: { id: "c", module: "forms", subject: "s" } },
    ]) {
      const actor = person(["*", "conversations:email", "contacts:merge"], { role: "admin", ...extra });
      expect(allows(actor, "conversations:email")).toBe(false);
      expect(allows(actor, "contacts:merge")).toBe(false);
      expect(effectiveAccess(actor, catalog.data)).not.toContain("conversations:email");
    }
  });
});

describe("Pessoas e aplicações", () => {
  it("marcar ou expandir '*' conserva separadas as concessões explícitas", () => {
    expect(toggleAccess(catalog.data, ["*"], "conversations:email", true)).toEqual(["*", "conversations:email"]);
    expect(toggleAccess(catalog.data, ["*", "conversations:email"], "conversations:email", false)).toEqual(["*"]);
    const limited = toggleAccess(catalog.data, ["*", "contacts:merge"], "calls", false);
    expect(limited).not.toContain("*");
    expect(limited).not.toContain("calls");
    expect(limited).not.toContain("conversations:email");
    expect(limited).toContain("contacts:merge");
    expect(toggleAccess(catalog.data, limited, "calls", true)).toEqual(["*", "contacts:merge"]);
  });

  it("editor mostra e marca as duas permissões somente quando concedidas", () => {
    const full = renderToStaticMarkup(React.createElement(AccessEditor, { catalog, value: ["*"], onChange: noop }));
    const granted = renderToStaticMarkup(React.createElement(AccessEditor, {
      catalog, value: ["*", "conversations:email", "contacts:merge"], onChange: noop,
    }));
    const plain = catalog.data.filter((item) => !item.explicitOnly && !item.role).length;
    expect(full.match(/checked=""/g)).toHaveLength(plain);
    expect(granted.match(/checked=""/g)).toHaveLength(plain + 2);
    expect(full).toContain("Enviar conversa por e-mail");
    expect(full).toContain("Juntar contatos");
    expect(full).toContain("Permissões com concessão explícita");
  });

  it("catálogo da aplicação oferece exportação explícita, exige leitura e exclui junção", () => {
    expect(applicationScopes(["*", "contacts:merge"])).toEqual(["*", "conversations:email"]);
    const granted = toggleApplicationScope(["tickets:read"], "conversations:email", true);
    expect(granted).toEqual(["tickets:read", "conversations:email", "conversations:read"]);
    expect(toggleApplicationScope(granted, "conversations:read", false)).toEqual(["tickets:read"]);
    expect(toggleApplicationScope(granted, "conversations:email", false)).toEqual(["tickets:read", "conversations:read"]);
    const html = renderToStaticMarkup(React.createElement(ApplicationScopes, {
      scopes: ["*", "contacts:merge"], value: ["*"], onChange: noop,
    }));
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain("Enviar conversa por e-mail (concessão explícita)");
    expect(html).not.toContain("contacts:merge");
    expect(html).toContain("Aplicações não têm destino");
  });
});

describe("configuração de e-mail existente", () => {
  it("endereço digitado começa desligado inclusive na demonstração só WhatsApp", () => {
    const api = vi.fn(() => { throw new Error("API inesperada"); });
    const html = renderToStaticMarkup(React.createElement(EmailSection, { api, demo: true }));
    expect(html).toContain("Desligado");
    expect(html).toContain("Permitir endereço digitado");
    expect(html).not.toContain('checked=""');
    expect(html).toContain("Enviar teste");
    expect(html).toContain("Esqueci a senha");
    expect(api).not.toHaveBeenCalled();
  });

  it("restrições administrativas explicam confirmação, domínios e cotas separadas", () => {
    const html = renderToStaticMarkup(React.createElement(TranscriptEmailSettings, {
      enabled: true, domains: "empresa.com.br", onEnabled: noop, onDomains: noop,
    }));
    expect(html).toContain('checked=""');
    expect(html).toContain("empresa.com.br");
    expect(html).toContain("exigem confirmação");
    expect(html).toContain("exatamente");
    expect(html).toContain("50 por área");
    expect(html).toContain("separado dos avisos dos módulos");
  });

  it("log apresenta transcrição, conversa, ator e incerteza sem oferecer reenvio", () => {
    const html = renderToStaticMarkup(React.createElement(EmailLog, { rows: [{
      id: "email-1", purpose: "conversation.email", to_masked: "cl***@empresa.com.br",
      status: "unknown", error_code: null, created: 1, conversation_id: "wa-1", user_id: "pessoa-1",
    }] }));
    expect(html).toContain("Transcrição de conversa");
    expect(html).toContain("cl***@empresa.com.br");
    expect(html).toContain("wa-1");
    expect(html).toContain("pessoa-1");
    expect(html).toContain("Resultado indeterminado");
    expect(html).toContain("não será reenviada automaticamente");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("cliente@empresa.com.br");
  });

  it("log antigo dos módulos mantém as colunas e situação anteriores", () => {
    const row = { id: "test", purpose: "test", to_masked: "p***@exemplo.test", status: "sending", error_code: null, created: 1 };
    const html = renderToStaticMarkup(React.createElement(EmailLog, { rows: [row] }));
    expect(html).toContain("Enviando");
    expect(html).not.toContain("Resultado indeterminado");
    expect(html).not.toContain("Solicitante");
    expect(renderToStaticMarkup(React.createElement(EmailLog, { rows: [] }))).toBe("");
    const transcript = renderToStaticMarkup(React.createElement(EmailLog, { rows: [{ ...row, purpose: "conversation.email" }] }));
    expect(transcript).toContain("Resultado indeterminado");
    expect(transcript).not.toContain("Enviando");
  });
});
