// Os adaptadores de boleto por API, um por banco (interface em ../adapter.ts).
import type { BoletoAdapter } from "../adapter.ts";
import type { BoletoBank } from "../contract.ts";
import { bb } from "./bb.ts";
import { inter } from "./inter.ts";
import { itau } from "./itau.ts";
import { sicoob } from "./sicoob.ts";

export const BOLETO_ADAPTERS: Readonly<Record<BoletoBank, BoletoAdapter>> = Object.freeze({ inter, sicoob, bb, itau });
