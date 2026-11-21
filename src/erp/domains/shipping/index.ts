// Expedição (structural.ts, expedicao; parte erp-expedicao): RPCs só do motor,
// registradas em ./rpc.ts; contas puras em ./model.ts. As rotas do Worker, a
// entrega local pelo módulo Entrega e o contrato dos bots ficam em src/erp/expedicao/.
import "./rpc.ts";
// Frete (cotação e etiqueta oficial): o que o serviço de frete (src/erp/frete/) lê e grava no pedido.
import "./freight.ts";

export {};
