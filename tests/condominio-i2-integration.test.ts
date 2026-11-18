import { it } from "vitest";
import { i2Harness } from "./os-i2-harness";
import { condominioIntegration } from "./os-i2-scenarios";
it("I2/condominio: registro, modelo, fluxo principal, área alheia e projeções de cliente/bot", () => condominioIntegration(i2Harness()), 60000);
