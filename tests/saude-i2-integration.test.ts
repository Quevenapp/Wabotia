import { it } from "vitest";
import { i2Harness } from "./os-i2-harness";
import { saudeIntegration } from "./os-i2-scenarios";
it("I2/saude: registro, modelo, fluxo principal, área alheia e projeções de cliente/bot", () => saudeIntegration(i2Harness()), 60000);
