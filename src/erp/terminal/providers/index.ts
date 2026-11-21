// Provedores de maquininha pela nuvem. Um provedor novo (Stone/Pagar.me,
// PagBank) implementa TerminalProvider (../adapter.ts), entra aqui e em
// TERMINAL_PROVIDERS (../contract.ts), sem mudar o PDV.
import type { TerminalProvider } from "../adapter.ts";
import type { TerminalProviderId } from "../contract.ts";
import { mercadoPagoPoint } from "./mercadopago-point.ts";

export const TERMINAL_ADAPTERS: Readonly<Record<TerminalProviderId, TerminalProvider>> = Object.freeze({ mercadopago: mercadoPagoPoint });
