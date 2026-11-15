import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform, settings } from "../src/service";
import { uid } from "../src/types";
import { configure, fixture } from "./service-center-fixture";

describe("PUT /settings com chave de módulo parcial", () => {
  it("mescla com o salvo: os campos que não vieram ficam como estavam", async () => {
    const f = await fixture();
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "agenda", enabled: true },
      uid(),
    );
    await configure(f, {
      agenda: { min_notice_minutes: 120, max_days_ahead: 15 },
    });
    // O painel (ou um app) manda só um campo.
    await configure(f, { agenda: { max_days_ahead: 40 } });
    const saved = (await settings(env, f.profile)).agenda;
    expect(saved).toMatchObject({
      min_notice_minutes: 120,
      max_days_ahead: 40,
    });
    // Valor inválido continua recusado.
    await expect(
      configure(f, { agenda: { slot_step_minutes: 3 } }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
