import { it } from "vitest";
import * as mask from "../src/pii-mask";
import * as pdf from "../src/pii-pdf";
import * as loop from "../src/bot-tools";
import { piiCases } from "./pii-cases.mjs";

for (const [name, check] of piiCases({ ...mask, ...pdf, ...loop }))
  it(name, check);
