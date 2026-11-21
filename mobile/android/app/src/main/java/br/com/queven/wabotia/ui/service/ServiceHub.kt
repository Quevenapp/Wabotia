package br.com.queven.wabotia.ui.service

import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.modules.ModuleRoutes
import br.com.queven.wabotia.modules.erp.ErpAccess
import br.com.queven.wabotia.modules.erp.ErpRoutes
import br.com.queven.wabotia.ui.nav.Routes

/** Grupos da aba Atendimento, na ordem em que aparecem. */
enum class ServiceSection(val label: String) {
    MODULES("Módulos da área"),
    MANAGEMENT("Gestão"),
    LINES("Linhas e menus"),
}

/** Uma entrada da aba Atendimento: [id] estável (ícone, cor e testes) e a rota que ela abre. */
data class ServiceEntry(val id: String, val section: ServiceSection, val title: String, val subtitle: String, val route: String)

/**
 * O que a aba Atendimento mostra (antes era a seção Atendimento dos Ajustes). Cada módulo só aparece ligado na área;
 * a Gestão só com o ERP ligado e um papel do ERP (ou administrador), item a item pela parte e pelo papel ([ErpAccess]);
 * menus e linhas dos bots só para administrador. Sem lógica de tela: as plataformas desenham a partir daqui.
 */
object ServiceHub {
    fun entries(modules: Set<String>, erp: ErpAccess?, isAdmin: Boolean): List<ServiceEntry> = buildList {
        fun module(id: String, title: String, subtitle: String, route: String) = add(ServiceEntry(id, ServiceSection.MODULES, title, subtitle, route))
        if (ModuleIds.QUEUE in modules) module("counter", "Guichê da fila de senhas", "Chamar a próxima senha, rechamar, concluir e transferir", Routes.COUNTER)
        if (ModuleIds.AGENDA in modules) module("agenda", "Agenda", "Agendamentos do dia e da semana por profissional", ModuleRoutes.AGENDA)
        if (ModuleIds.SERVICE_ORDERS in modules) module("os", "Ordens de serviço", "Recebidas, orçamentos, execução e entrega", ModuleRoutes.SERVICE_ORDERS)
        if (ModuleIds.RESERVA in modules) module("reserva", "Reservas", "Ocupação das unidades, sinal e check-in", ModuleRoutes.RESERVA)
        if (ModuleIds.MENSALIDADE in modules) module("mensalidade", "Mensalidades", "Parcelas do mês, assinaturas e inadimplentes", ModuleRoutes.MENSALIDADE)
        if (ModuleIds.PEDIDO in modules) module("pedido", "Pedidos", "Quadro da cozinha, comanda, pausa da loja e esgotados", ModuleRoutes.PEDIDO)

        if (erp != null) {
            fun management(id: String, title: String, subtitle: String, route: String) = add(ServiceEntry(id, ServiceSection.MANAGEMENT, title, subtitle, route))
            if (erp.customers) management("erp.customers", "Clientes", "Busca, ficha, ligar e WhatsApp" + (if (erp.canCreateCustomer) "; cadastro rápido" else ""), ErpRoutes.CUSTOMERS)
            if (erp.products) management("erp.products", "Produtos e estoque", "Busca por nome, código ou código de barras" + (if (erp.stock) "; saldo por depósito" else ""), ErpRoutes.PRODUCTS)
            if (erp.quickOrder) management("erp.order", "Pedido rápido", "Cliente, itens, desconto e pagamento", ErpRoutes.ORDER)
            if (erp.bills) management("erp.bills", "Contas", "A receber e a pagar do dia e vencidas", ErpRoutes.BILLS)
        }

        add(ServiceEntry("lines", ServiceSection.LINES, "Linhas de atendimento", "Quem atende cada número e quando os menus aparecem", Routes.LINES))
        if (isAdmin) {
            add(ServiceEntry("menus", ServiceSection.LINES, "Menus e submenus", "Opções, destinos e linhas permitidas", Routes.MENUS))
            add(ServiceEntry("bot-lines", ServiceSection.LINES, "Linhas dos bots", "Em quais linhas cada bot pode atender", Routes.BOT_LINES))
        }
    }

    /** As entradas agrupadas por seção, na ordem da tela; seções vazias somem. */
    fun sections(entries: List<ServiceEntry>): List<Pair<ServiceSection, List<ServiceEntry>>> =
        ServiceSection.entries.mapNotNull { section -> entries.filter { it.section == section }.takeIf { it.isNotEmpty() }?.let { section to it } }
}
