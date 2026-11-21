// Lojas e filiais (structural.ts, lojas; tabelas erp_store__*, versão 27):
// RPCs só do motor em ./rpc.ts, a guarda nos RPCs de sempre em ./guard.ts,
// o que os outros domínios leem em ./public.ts e as contas puras em ./model.ts.
// As rotas do Worker e o contrato dos bots ficam em src/erp/lojas/.
import "./rpc.ts";
import "./guard.ts";

export {};
