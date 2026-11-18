import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { json } from "../src/types";
import { registerAdminExtension, onSettingsSave } from "../src/modules/api";
import { moduleStates } from "../src/modules/registry";
import {
  applyAreaTemplate, areaTemplatesExtension, previewAreaTemplate, validateAreaSetup,
} from "../src/area-templates";
import { assistenciaTecnicaTemplate } from "../src/area-templates/models/assistencia-tecnica";
import { moduleLabel, templateSelection } from "../web/admin/area-templates/AreaTemplatesPage";
import { fixture } from "./service-center-fixture";

// Seleção padrão do painel (Gestão → Modelos de área) aplicada no servidor.
registerAdminExtension(areaTemplatesExtension);
onSettingsSave("os", "os_area_setup", validateAreaSetup);

describe("Modelos de área: seleção padrão do painel", () => {
  it("só liga módulos e inclui o embutido quando o modelo tem menus da Ordem de serviço", () => {
    const selection = templateSelection(assistenciaTecnicaTemplate as any);
    expect(selection.work_type_ids[0]).toBe("service_order");
    const off = Object.entries(assistenciaTecnicaTemplate.modules).filter(([, on]) => !on).map(([id]) => id);
    expect(off).toContain("forms");
    for (const id of off) expect(selection.module_ids).not.toContain(id);
    expect(selection.module_ids).toContain("os");
  });

  it("aplicar o padrão mantém Formulários ligado e cria os menus da Ordem de serviço embutida", async () => {
    const f = await fixture();
    await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?, 'forms', 1, 1, ?)", f.profile, f.admin.id);
    const input = { manifest: assistenciaTecnicaTemplate, selection: templateSelection(assistenciaTecnicaTemplate as any) };
    const preview = await previewAreaTemplate(env, f.admin, f.profile, input as any);
    expect(preview.conflicts).toEqual([]);
    expect(preview.changes.find((c: any) => c.path === "modules.forms")).toBeUndefined();
    await applyAreaTemplate(env, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash } as any);
    expect((await moduleStates(env, f.profile)).forms).toBe(true);
    const settings = json((await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))!.settings);
    const builtin = settings.menus.filter((menu: any) => menu.type_id === "service_order").map((menu: any) => menu.type).sort();
    expect(builtin).toEqual(["os_open", "os_track"]);
  });

  it("descreve cada módulo pelo nome e avisa só quando a pessoa marca o desligamento", () => {
    expect(moduleLabel("os", false, true, true)).toBe("Ordem de serviço: desligado → ligar");
    expect(moduleLabel("payments", true, true, true)).toBe("Cobrança: ligado, sem mudança");
    expect(moduleLabel("forms", true, false, false)).toContain("continua ligado");
    expect(moduleLabel("forms", true, false, true)).toBe("Formulários: ligado → será DESLIGADO");
  });
});
