// Hashes sobre ids novos (declarados): o RPC devolve um sha256 de linhas que
// ele mesmo acabou de criar com gen_random_uuid. Os dois motores geram ids
// diferentes, então o hash da própria resposta difere mesmo com o
// comportamento igual; na chamada seguinte o SQLite já tem as linhas do
// Postgres (espelho) e o hash volta a ser comparado literalmente.
// Cada entrada diz o RPC e a chave da resposta; fora delas, hash é texto.
const registry = new Map();

/** Declara a chave `key` da resposta de `rpc` como hash sobre ids novos. */
export function registerVolatileHash({ rpc, key, reason }) {
  if (!rpc || !key || !reason) throw new Error("Hash volátil: diga rpc, key e o motivo.");
  const k = `${rpc}\u0000${key}`;
  if (registry.has(k)) throw new Error(`Hash volátil ${rpc}.${key} já registrado.`);
  registry.set(k, Object.freeze({ rpc, key, reason }));
}

const HEX64 = /^[0-9a-f]{64}$/;
/** As duas pontas são sha256 numa chave declarada para este RPC. */
export const volatileHash = (rpc, key, pg, lite) =>
  rpc !== undefined && rpc !== null && key !== undefined && registry.has(`${rpc}\u0000${key}`) && HEX64.test(pg) && HEX64.test(lite);

// Estoque (N): a cadeia de recebimentos do pedido de compra inclui o id do
// recebimento ou do estorno que o próprio RPC grava.
for (const rpc of ["erp_purchase_receipts_receive", "erp_purchase_receipts_reverse"])
  registerVolatileHash({ rpc, key: "chain_hash", reason: "erp_purchase_receipts.chain_hash inclui o id novo do recebimento/estorno" });
