// Conciliação bancária e de cartões (structural.ts, conciliacao; tabelas
// erp_reconciliation__*, versão 30; parte Financeiro): RPCs só do motor em
// ./rpc.ts e as contas puras (OFX, planilhas, cartão, confiança) em ./model.ts.
// As rotas do Worker e o contrato dos bots ficam em src/erp/conciliacao/.
import "./rpc.ts";
// O pagamento aprovado na maquininha integrada ao caixa (src/erp/terminal/), já casado com a venda.
import "./terminal.ts";

export {};
