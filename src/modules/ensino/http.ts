// A entrada HTTP importa este módulo sem carregar os descritores de Ensino.
// Importá-los aqui criaria o ciclo ensino → security → web-steps → service → runtime.
import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../../types";

/** Registrar antes do despacho de módulos; inclusive erros não podem ser cacheados. */
export const ensinoNoStore: MiddlewareHandler<Bindings> = async (c, next) => {
  c.header("Cache-Control", "no-store, private");
  c.header("Referrer-Policy", "no-referrer");
  await next();
};
