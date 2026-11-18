// Carrega o código dos módulos embutidos, que registra seus ganchos
// (src/modules/hooks.ts) ao ser importado. Importado pela entrada do Worker,
// pelo motor e pelo serviço: um módulo novo entra nesta lista e em
// modules[] de src/modules/registry.ts.
import "./forms/forms";
import "./agenda/agenda";
import "./os/os";
import "./payments/payments";
import "./mensalidade/mensalidade";
import "./suporte/suporte";
import "./reserva/reserva";
import "./pedido/pedido";
import "./mesas/mesas";
import "./entrega/entrega";
// Fila do núcleo: só a ferramenta "minha senha" do bot (src/queue.ts).
import "./queue-tools";
import "./os/extension-runtime";

// REGISTRO RESERVADO F0/I — novos registros no fim deste bloco.
// A exporta AdminExtension; importar aqui e chamar registerAdminExtension.
// T/P/D/L entram somente na lista de os/extensions.ts.
