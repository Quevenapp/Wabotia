import { it } from "vitest";
import { i2Harness } from "./os-i2-harness";
import { ensinoIntegration } from "./os-i2-scenarios";
it("I2/ensino: registro, modelo, fluxo principal, área alheia e projeções de cliente/bot", () => ensinoIntegration(i2Harness()), 60000);
