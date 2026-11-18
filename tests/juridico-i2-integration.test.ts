import { it } from "vitest";
import { i2Harness } from "./os-i2-harness";
import { juridicoIntegration } from "./os-i2-scenarios";
it("I2/juridico: registro, modelo, fluxo principal, área alheia e projeções de cliente/bot", () => juridicoIntegration(i2Harness()), 60000);
