package br.com.queven.wabotia.ui.service

import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.demo.DemoMode
import br.com.queven.wabotia.modules.BasicRoutes
import br.com.queven.wabotia.modules.ModuleRoutes
import br.com.queven.wabotia.ui.nav.Routes

/** Grupos da aba Atendimento, na ordem em que aparecem. */
enum class ServiceSection(val label: String) {
    MODULES("Módulos da área"),
    DAILY("Do dia a dia"),
    ASSISTANT("Gestão"),
    LINES("Linhas e menus"),
}

/**
 * Uma entrada da aba Atendimento: [id] estável (ícone, cor e testes) e a rota que ela abre. Rota que começa com
 * [ServiceHub.WEB] é um endereço do painel: abre no navegador.
 */
data class ServiceEntry(val id: String, val section: ServiceSection, val title: String, val subtitle: String, val route: String) {
    val opensBrowser: Boolean get() = route.startsWith(ServiceHub.WEB)
    val webPath: String? get() = if (opensBrowser) route.removePrefix(ServiceHub.WEB) else null
}

/**
 * O que a aba Atendimento mostra: só o básico do atendimento, o que dá para fazer sem computador (DESIGN.md, seção 10).
 * Cada módulo aparece só ligado na área; o Caixa simples, com a parte Financeiro ligada e um papel que mexe no caixa.
 * Clientes, Equipamentos e o assistente ficam sempre. O ERP, os relatórios e as configurações dos módulos não aparecem:
 * o assistente responde pelo bot e o painel abre no navegador. Sem lógica de tela: as plataformas desenham a partir daqui.
 */
object ServiceHub {
    /** Prefixo das rotas que abrem o painel no navegador. */
    const val WEB = "web:"

    /** Papéis do ERP que abrem e fecham caixa (o controle de caixa do Financeiro, src/erp/role-resources.ts). */
    private val CASH_ROLES = setOf("erp:admin", "erp:financeiro")

    /** O Caixa simples aparece? Parte Financeiro ligada e administrador ou papel Financeiro do ERP. */
    fun cashAllowed(modules: Set<String>, grants: Set<String>, isAdmin: Boolean): Boolean =
        ModuleIds.ERP_FINANCE in modules && (isAdmin || grants.any { it in CASH_ROLES })

    fun entries(modules: Set<String>, grants: Set<String>, isAdmin: Boolean): List<ServiceEntry> = buildList {
        fun module(id: String, title: String, subtitle: String, route: String) = add(ServiceEntry(id, ServiceSection.MODULES, title, subtitle, route))
        if (ModuleIds.QUEUE in modules) module("counter", "Fila de senhas", "Guichê: chamar, rechamar e finalizar; painéis ligados", Routes.COUNTER)
        if (ModuleIds.AGENDA in modules) module("agenda", "Agenda", "Agendamentos do dia e marcar horário", ModuleRoutes.AGENDA)
        if (ModuleIds.MENSALIDADE in modules) module("mensalidade", "Mensalidades", "Parcelas do mês e inadimplentes", ModuleRoutes.MENSALIDADE)
        if (ModuleIds.RESERVA in modules) module("reserva", "Reservas", "Ocupação das unidades, sinal e check-in", ModuleRoutes.RESERVA)
        if (ModuleIds.MESAS in modules) module("mesas", "Mesas", "Abrir mesa, ver a conta e pedir o fechamento", BasicRoutes.MESAS)
        if (ModuleIds.ENTREGA in modules) module("entrega", "Entregas", "Minhas entregas: sair para entregar e confirmar", BasicRoutes.ENTREGA)
        if (ModuleIds.PEDIDO in modules) module("pedido", "Pedidos", "Quadro da cozinha, comanda, pausa da loja e esgotados", ModuleRoutes.PEDIDO)
        if (ModuleIds.SERVICE_ORDERS in modules) module("os", "Ordens de serviço", "Recebidas, orçamentos, execução e entrega", ModuleRoutes.SERVICE_ORDERS)

        fun daily(id: String, title: String, subtitle: String, route: String) = add(ServiceEntry(id, ServiceSection.DAILY, title, subtitle, route))
        if (cashAllowed(modules, grants, isAdmin)) daily("caixa", "Caixa", "Abrir com troco, lançar entradas e saídas, fechar com conferência", BasicRoutes.CAIXA)
        daily("clientes", "Clientes", "Cadastro básico: nome, telefone, e-mail e observação", BasicRoutes.CLIENTES)
        daily("equipamentos", "Equipamentos", "Painéis de senha e impressoras: parear, testar e ver situação", BasicRoutes.EQUIPAMENTOS)

        add(ServiceEntry("assistente", ServiceSection.ASSISTANT, "Perguntar ao assistente", "Vendas, estoque, contas e clientes do ERP em linguagem natural", BasicRoutes.ASSISTENTE))
        add(ServiceEntry("web", ServiceSection.ASSISTANT, "Abrir no navegador", "ERP, relatórios e configurações dos módulos ficam no painel", WEB + WebPanel.home(modules)))

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

/**
 * Endereços do painel web (web/lib/routes.ts) para o "Abrir no navegador": o que é avançado mora lá. Montados sobre o
 * endereço do servidor da sessão.
 */
object WebPanel {
    /** ERP ligado: o início do ERP; sem ele, o início da Gestão. */
    fun home(modules: Set<String>): String = if (ModuleIds.ERP in modules) "/app/erp" else "/app/gestao/inicio"

    /** Controle de caixa completo (sangria, reabrir, conferido, outros caixas). */
    const val CASH = "/app/erp/financeiro-empresa?area=controle-caixa"
    const val CONTACTS = "/app/contatos"
    const val MESAS = "/app/gestao/mesas"
    const val DELIVERIES = "/app/gestao/entregas"
    const val QUEUE = "/app/fila"
    const val QUEUE_SETTINGS = "/app/gestao/filas"
    const val PAIRINGS = "/app/gestao/sistemas"
    const val MODULES = "/app/gestao/modulos"

    /** O endereço completo; `null` sem servidor de verdade (demonstração). */
    fun url(server: String?, path: String): String? =
        server?.trim()?.trimEnd('/')
            ?.takeIf { (it.startsWith("http://") || it.startsWith("https://")) && !DemoMode.isDemo(it) }
            ?.let { it + path }
}
