// Compra pela nota recebida (structural.ts, compra-nota-recebida): RPCs só do
// motor, registradas em ./rpc.ts. O serviço que fala com o cofre e o R2 fica
// em src/erp/recebidas/.
import "./rpc.ts";
// Reposição pelo mínimo e máximo e inventário valorizado numa data.
import "./replenishment.ts";

export {};
