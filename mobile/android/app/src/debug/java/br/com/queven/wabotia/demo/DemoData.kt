package br.com.queven.wabotia.demo

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import java.time.LocalDate
import java.time.ZoneId
import java.util.TreeMap

// Estado em memória do servidor de demonstração (somente build de depuração) e os dados iniciais.

/** Identificadores fixos, usados também pelos atalhos de tela em [DemoMode]. */
internal object Ids {
    const val PROFILE = "demo-profile"

    const val ME = "u-bruno"
    const val ANA = "u-ana"
    const val MARINA = "u-marina"
    const val CARLOS = "u-carlos"

    const val BOT_VENDAS = "b-vendas"
    const val BOT_SUPORTE = "b-suporte"

    const val LINE_META = "ln-meta"
    const val LINE_ZERNIO = "ln-zernio"

    const val DEP_FINANCEIRO = "dep-financeiro"
    const val DEP_SUPORTE = "dep-suporte"

    const val C_RICH = "c-rich"
    const val C_5H = "c-5h"
    const val C_40MIN = "c-40min"
    const val C_WINDOW_CLOSED = "c-window-closed"
    const val C_QUEUE = "c-queue"
    const val C_QUEUE2 = "c-queue2"
    const val C_BOT = "c-bot"
    const val C_ANA = "c-ana"
    const val C_DONE = "c-done"
    const val C_GROUP = "c-group"

    const val T_OVERDUE = "t-overdue"
    const val T_SOON = "t-soon"
    const val T_PROGRESS = "t-progress"
    const val T_ANSWERED = "t-answered"
    const val T_THIRD = "t-third"
    const val T_RESOLVED = "t-resolved"
    const val T_CLOSED = "t-closed"

    const val CAT_WABOTIA = "wabotia"
    const val CAT_PRINTHER = "printher"
    const val CAT_NFSE = "nfse-leve"
    const val CAT_FAGOO = "fagoo-erp"
    const val CAT_SERVIDOR = "servidor-integracao"
    const val CAT_OUTRO = "outro"

    const val CHAT_ANA = "ic-ana"
    const val CHAT_VENDAS = "ic-vendas"

    const val CALL_RINGING = "call-ringing"
}

// --- pequenos auxiliares de JSON ---

/** Linha mutável (como uma linha do banco): chave → valor JSON. */
internal typealias Row = MutableMap<String, JsonElement>

internal fun Any?.toJson(): JsonElement = when (this) {
    null -> JsonNull
    is JsonElement -> this
    is String -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this)
    is Boolean -> JsonPrimitive(this)
    is Map<*, *> -> JsonObject(entries.associate { it.key.toString() to it.value.toJson() })
    is Iterable<*> -> JsonArray(map { it.toJson() })
    else -> JsonPrimitive(toString())
}

internal fun j(vararg pairs: Pair<String, Any?>): JsonObject {
    val map = LinkedHashMap<String, JsonElement>()
    for ((key, value) in pairs) map[key] = value.toJson()
    return JsonObject(map)
}

internal fun row(vararg pairs: Pair<String, Any?>): Row {
    val map = LinkedHashMap<String, JsonElement>()
    for ((key, value) in pairs) map[key] = value.toJson()
    return map
}

internal fun Row.assign(key: String, value: Any?) {
    put(key, value.toJson())
}

internal fun Map<String, JsonElement>.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
internal fun Map<String, JsonElement>.long(key: String): Long = (this[key] as? JsonPrimitive)?.longOrNull ?: 0L
internal fun Map<String, JsonElement>.longOrNull(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull
internal fun Map<String, JsonElement>.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.let { it.booleanOrNull ?: it.longOrNull?.let { n -> n != 0L } }
internal fun Row.json(): JsonObject = JsonObject(LinkedHashMap(this))

internal class Task(val at: Long, val run: (at: Long) -> Unit)

internal class Upload(val name: String, val type: String, val size: Long) {
    val parts = TreeMap<Int, ByteArray>()
}

/** Tudo o que o servidor fictício guarda. Recriado a cada entrada na demonstração. */
internal class DemoState(val t0: Long) {
    val users = linkedMapOf(
        Ids.ME to "Bruno Almeida",
        Ids.ANA to "Ana Souza",
        Ids.MARINA to "Marina Lopes",
        Ids.CARLOS to "Carlos Pereira",
    )
    val present = hashMapOf(Ids.ME to true, Ids.ANA to true, Ids.MARINA to true, Ids.CARLOS to false)
    val bots = ArrayList<Row>()
    val botOnline = hashMapOf(Ids.BOT_VENDAS to true, Ids.BOT_SUPORTE to false)
    val lines = ArrayList<Row>()
    var menus: List<JsonObject> = emptyList()
    var departments: List<JsonObject> = emptyList()
    /** `settings.ticket_categories` (servidor 0.14): aplicativo ou assunto do protocolo. */
    var ticketCategories: List<JsonObject> = emptyList()

    val conversations = LinkedHashMap<String, Row>()
    val messages = HashMap<String, MutableList<Row>>()
    val deliveries = HashMap<String, MutableList<Row>>()
    val contacts = HashMap<String, JsonObject>()
    val groups = HashMap<String, JsonObject>()
    val media = HashMap<String, DemoMedia.Entry>()
    val uploads = HashMap<String, Upload>()

    val tickets = LinkedHashMap<String, Row>()
    val ticketUpdates = HashMap<String, MutableList<Row>>()
    var ticketSeq = 185

    val botRuns = ArrayList<Row>()
    val calls = ArrayList<Row>()
    val chats = LinkedHashMap<String, Row>()
    val chatMessages = HashMap<String, MutableList<Row>>()
    val devices = LinkedHashMap<String, Row>()

    val events = ArrayList<JsonObject>()
    val scheduled = ArrayList<Task>()
    /** Conversa → horário da resposta automática do cliente já agendada. */
    val pendingCustomerReply = HashMap<String, Long>()
    /** Quantas respostas automáticas de cliente já saíram (a primeira é sempre "Perfeito, obrigado!"). */
    var autoReplies = 0

    private var counter = 0
    fun nextId(prefix: String): String = "$prefix-${++counter}"

    fun userName(id: String?): String = users[id] ?: botName(id) ?: "Atendente"
    fun botName(id: String?): String? {
        val raw = id?.removePrefix("bot:") ?: return null
        return bots.firstOrNull { it.str("id") == raw }?.str("name")
    }

    /** Minutos atrás, a partir do instante em que a demonstração começou. */
    fun minAgo(minutes: Int): Long = t0 - minutes * 60_000L
    fun hoursAgo(hours: Double): Long = t0 - (hours * 3_600_000L).toLong()

    private fun yesterdayAt(hour: Int, minute: Int): Long {
        val zone = ZoneId.systemDefault()
        val day = LocalDate.now(zone).minusDays(1)
        return day.atTime(hour, minute).atZone(zone).toInstant().toEpochMilli()
    }

    // --- montagem dos dados ---

    fun addMessage(
        conversationId: String,
        direction: String,
        author: String,
        text: String,
        at: Long,
        status: String = "",
        content: JsonObject = JsonObject(emptyMap()),
        attachments: List<String> = emptyList(),
        id: String? = null,
    ): Row {
        val list = messages.getOrPut(conversationId) { ArrayList() }
        val messageId = id ?: "m-$conversationId-${list.size + 1}"
        val message = row(
            "id" to messageId,
            "profile_id" to Ids.PROFILE,
            "conversation_id" to conversationId,
            "direction" to direction,
            "author" to author,
            "text" to text,
            "attachments" to JsonArray(attachments.map { JsonPrimitive(it) }).toString(),
            "external_id" to if (direction == "customer" || direction == "outbound" || direction == "operator") "wamid.DEMO.$messageId" else null,
            "created" to at,
            "content" to content.toString(),
            "delivery_status" to status,
            "status_at" to at,
        )
        list += message
        return message
    }

    private fun conversation(
        id: String,
        name: String,
        phone: String?,
        state: String,
        owner: String?,
        line: String,
        lastCustomer: Long,
        updated: Long,
        created: Long,
        tags: List<String> = emptyList(),
        department: String? = null,
        bot: String? = null,
        group: Boolean = false,
        contact: JsonObject? = null,
    ) {
        conversations[id] = row(
            "id" to id,
            "profile_id" to Ids.PROFILE,
            "connection_id" to line,
            "external_namespace" to "whatsapp",
            "external_id" to (phone ?: "120363041234567890@g.us"),
            "phone" to phone,
            "state" to state,
            "owner" to owner,
            "epoch" to 1,
            "topic" to null,
            "tags" to JsonArray(tags.map { JsonPrimitive(it) }).toString(),
            "last_customer" to lastCustomer,
            "created" to created,
            "updated" to updated,
            "chat_type" to if (group) "group" else "direct",
            "title" to if (group) name else "",
            "bot_policy" to "mentions",
            "recipient_id" to null,
            "contact_name" to if (group) null else name,
            "contact_id" to if (group) null else "ct-$id",
            "department_id" to department,
            "assigned_bot_id" to bot,
        )
        if (!group) {
            contacts["ct-$id"] = contact ?: j("id" to "ct-$id", "name" to name, "phone" to phone, "email" to null, "company" to null, "notes" to null, "version" to 1)
        }
    }

    fun seed() {
        for (entry in DemoMedia.fixtures()) media[entry.id] = entry

        bots += row(
            "id" to Ids.BOT_VENDAS, "profile_id" to Ids.PROFILE, "connection_id" to "hermes-queven", "remote_profile" to "vendas",
            "name" to "Vendas", "enabled" to 1, "line_ids" to null,
        )
        bots += row(
            "id" to Ids.BOT_SUPORTE, "profile_id" to Ids.PROFILE, "connection_id" to "hermes-queven", "remote_profile" to "suporte",
            "name" to "Suporte", "enabled" to 1, "line_ids" to "[\"${Ids.LINE_META}\"]",
        )

        val policy = j("pool" to true, "human" to true, "bots" to true, "menu" to true, "api" to true, "service" to true, "templates" to true, "purpose" to "custom")
        lines += row(
            "id" to Ids.LINE_META, "name" to "WhatsApp Vendas", "kind" to "meta", "mode" to "cloud", "status" to "active",
            "number" to "+55 11 4000-1234", "number_policy" to policy, "service" to j("mode" to "inherit", "bot_id" to null, "menu_mode" to "automatic"),
        )
        lines += row(
            "id" to Ids.LINE_ZERNIO, "name" to "WhatsApp Suporte", "kind" to "zernio", "mode" to "cloud", "status" to "active",
            "number" to "+55 11 4000-5678", "number_policy" to policy, "service" to j("mode" to "human", "bot_id" to null, "menu_mode" to "manual"),
        )

        departments = listOf(
            j("id" to Ids.DEP_FINANCEIRO, "name" to "Financeiro", "enabled" to true, "members" to listOf(Ids.ANA, Ids.CARLOS, Ids.ME)),
            j("id" to Ids.DEP_SUPORTE, "name" to "Suporte", "enabled" to true, "members" to listOf(Ids.MARINA, Ids.ANA)),
        )

        ticketCategories = listOf(
            j("id" to Ids.CAT_WABOTIA, "name" to "Wabotia", "enabled" to true),
            j("id" to Ids.CAT_PRINTHER, "name" to "Printher", "enabled" to true),
            j("id" to Ids.CAT_NFSE, "name" to "NFS-e Leve", "enabled" to true),
            j("id" to Ids.CAT_FAGOO, "name" to "Fagoo ERP", "enabled" to true),
            j("id" to Ids.CAT_SERVIDOR, "name" to "Servidor ou integração", "enabled" to true),
            j("id" to Ids.CAT_OUTRO, "name" to "Outro ou não sei", "enabled" to true),
            j("id" to "vinki", "name" to "Vinki", "enabled" to false),
        )

        fun menu(id: String, label: String, type: String, parent: String? = null, bot: String = "") = j(
            "id" to id, "label" to label, "type" to type, "parent_id" to parent, "bot_id" to bot, "app_id" to "",
            "enabled" to true, "trigger" to "automatic", "line_ids" to emptyList<String>(),
        )
        menus = listOf(
            menu("mn-atendente", "Falar com atendente", "human"),
            menu("mn-vendas", "Vendas", "bot", bot = Ids.BOT_VENDAS),
            menu("mn-financeiro", "Financeiro", "submenu"),
            menu("mn-suporte", "Suporte técnico", "submenu"),
            menu("mn-fin-boleto", "Segunda via de boleto", "bot", parent = "mn-financeiro", bot = Ids.BOT_VENDAS),
            menu("mn-fin-nota", "Nota fiscal", "human", parent = "mn-financeiro"),
            menu("mn-fin-cobranca", "Contestar uma cobrança", "human", parent = "mn-financeiro"),
            menu("mn-sup-acesso", "Problemas de acesso", "bot", parent = "mn-suporte", bot = Ids.BOT_SUPORTE),
            menu("mn-sup-integracao", "Integrações e API", "human", parent = "mn-suporte"),
            // Destinos que o aplicativo não monta, mas precisa mostrar e preservar ao editar.
            JsonObject(
                menu("mn-sup-protocolo", "Abrir protocolo", "ticket", parent = "mn-suporte") +
                    ("category_id" to JsonPrimitive(Ids.CAT_WABOTIA)) +
                    ("content" to JsonPrimitive("Descreva em uma mensagem o que você precisa. Se puder, diga o que tentou e o que aconteceu.")),
            ),
            menu("mn-protocolos", "Meus protocolos", "protocols"),
        )

        seedConversations()
        seedTickets()
        seedBotRuns()
        seedCalls()
        seedInternalChats()
    }

    private fun seedConversations() {
        val me = Ids.ME
        val vendas = "bot:${Ids.BOT_VENDAS}"

        // (1) conversa completa, minha, ~23 h de janela
        val richPhone = "5511987654321"
        conversation(
            Ids.C_RICH, "Mariana Costa", richPhone, "human", me, Ids.LINE_META,
            lastCustomer = minAgo(50), updated = minAgo(2), created = yesterdayAt(16, 2), tags = listOf("VIP", "Financeiro"),
            contact = j(
                "id" to "ct-${Ids.C_RICH}", "name" to "Mariana Costa", "phone" to richPhone, "email" to "mariana@costafilhos.com.br",
                "company" to "Costa & Filhos Contabilidade", "notes" to "Indicação da Fagoo. Prefere contato pela manhã.", "version" to 3,
            ),
        )
        val r = Ids.C_RICH
        addMessage(r, "customer", richPhone, "Oi, boa tarde! Queria saber sobre o plano empresarial de vocês.", yesterdayAt(16, 2))
        addMessage(
            r, "outbound", vendas,
            "Olá, Mariana! Sou a assistente virtual da Queven. Posso ajudar com planos, valores e segunda via de boleto. Sobre o que você quer falar?",
            yesterdayAt(16, 2), "read",
        )
        addMessage(r, "system", "system", "Menu enviado ao cliente", yesterdayAt(16, 3))
        addMessage(r, "customer", richPhone, "Quero falar com um atendente, por favor.", yesterdayAt(16, 5))
        addMessage(r, "system", "system", "Conversa assumida por Bruno Almeida", yesterdayAt(16, 6))
        addMessage(r, "outbound", me, "Oi, Mariana! Aqui é o Bruno, do time comercial. Me conta: quantas pessoas vão usar o atendimento?", yesterdayAt(16, 7), "read")
        val team = addMessage(r, "customer", richPhone, "Somos 12 atendentes hoje, mas a ideia é chegar a 20 até o fim do ano.", yesterdayAt(16, 9))
        addMessage(
            r, "outbound", me, "Perfeito. Para esse tamanho o plano Empresarial atende bem e já inclui os bots de vendas e de suporte.",
            yesterdayAt(16, 12), "read",
            content = j(
                "type" to "text",
                "reply_to" to team.str("id"),
                "reply_text" to team.str("text"),
                "reactions" to j(richPhone to j("emoji" to "👍", "at" to yesterdayAt(16, 13))),
            ),
        )
        addMessage(
            r, "customer", richPhone, "Esse é o painel que usamos hoje. Dá para migrar o histórico?", yesterdayAt(16, 15),
            content = j("type" to "image"), attachments = listOf(DemoMedia.IMAGE_ID),
        )
        addMessage(r, "note", Ids.ANA, "Cliente veio por indicação da Fagoo. Dá para aplicar o desconto de parceiro.", yesterdayAt(16, 20))
        addMessage(
            r, "outbound", me, "Segue a proposta com os valores para 20 atendentes.", yesterdayAt(16, 24), "read",
            content = j("type" to "document"), attachments = listOf(DemoMedia.PDF_ID),
        )
        addMessage(r, "system", "system", "Transferida de Bruno Almeida para Ana Souza", yesterdayAt(18, 1))

        addMessage(r, "system", "system", "Transferida de Ana Souza para Bruno Almeida", minAgo(190))
        addMessage(r, "customer", richPhone, "", minAgo(180), content = j("type" to "voice"), attachments = listOf(DemoMedia.VOICE_ID))
        addMessage(
            r, "outbound", me, "Ouvi aqui! Dá sim: a migração do histórico está incluída na implantação.", minAgo(175), "read",
            content = j("type" to "text", "edited" to true),
        )
        addMessage(r, "note", me, "Prometi retorno sobre a migração até amanhã. Alinhar o formato de exportação com o suporte.", minAgo(170))
        addMessage(r, "system", "system", "Protocolo WA-2026-000184 aberto", minAgo(160))
        addMessage(r, "customer", richPhone, "Ótimo! Vocês atendem presencialmente também? Onde fica o escritório?", minAgo(150))
        addMessage(
            r, "outbound", me, "", minAgo(148), "delivered",
            content = j(
                "type" to "location",
                "location" to j("latitude" to -23.561684, "longitude" to -46.655981, "name" to "Queven Matriz", "address" to "Av. Paulista, 1578 · Bela Vista, São Paulo"),
            ),
        )
        addMessage(
            r, "customer", richPhone, "Esse é o contato do nosso financeiro, pode tratar do contrato com ele.", minAgo(140),
            content = j("type" to "contacts", "contacts" to listOf(j("name" to "Rafael Nunes (Financeiro)", "phone" to "5511912345678"))),
        )
        val failed = addMessage(r, "outbound", me, "Combinado, vou falar com o Rafael ainda hoje.", minAgo(90), "failed")
        addMessage(r, "outbound", me, "Mariana, consegue me confirmar o CNPJ para eu emitir o contrato?", minAgo(85), "delivered")
        addMessage(r, "customer", richPhone, "Claro! É 12.345.678/0001-90. Pode mandar o contrato para este número mesmo.", minAgo(50))
        addMessage(r, "outbound", me, "Recebido, obrigado! Envio o contrato ainda hoje.", minAgo(48), "sent")
        val pending = addMessage(r, "outbound", me, "Contrato a caminho. Qualquer dúvida, é só chamar por aqui.", minAgo(2), "pending")
        deliveries[r] = arrayListOf(
            row("id" to "d-failed", "status" to "failed", "error" to "Número sem WhatsApp ativo", "created" to minAgo(90), "message_id" to failed.str("id")),
            row("id" to "d-pending", "status" to "pending", "error" to null, "created" to minAgo(2), "message_id" to pending.str("id")),
        )

        // (2) minha, ~5 h de janela
        val joao = "5511991234567"
        conversation(Ids.C_5H, "João Pedro Martins", joao, "human", me, Ids.LINE_META, lastCustomer = hoursAgo(19.0), updated = hoursAgo(19.0), created = hoursAgo(19.4), tags = listOf("Boleto"))
        addMessage(Ids.C_5H, "customer", joao, "Bom dia! Não recebi o boleto deste mês.", hoursAgo(19.35))
        addMessage(Ids.C_5H, "system", "system", "Conversa assumida por Bruno Almeida", hoursAgo(19.3))
        addMessage(Ids.C_5H, "outbound", me, "Bom dia, João! Vou verificar agora mesmo.", hoursAgo(19.2), "read")
        addMessage(Ids.C_5H, "outbound", me, "Acabei de reenviar para o e-mail cadastrado. Consegue conferir?", hoursAgo(19.1), "read")
        addMessage(Ids.C_5H, "customer", joao, "Chegou sim!", hoursAgo(19.04))
        addMessage(Ids.C_5H, "customer", joao, "Mas veio com o valor antigo 😕", hoursAgo(19.02))
        addMessage(Ids.C_5H, "customer", joao, "Consegue gerar a segunda via atualizada?", hoursAgo(19.0))

        // (3) minha, ~40 min de janela
        val fernanda = "5521998765432"
        conversation(Ids.C_40MIN, "Fernanda Oliveira", fernanda, "human", me, Ids.LINE_META, lastCustomer = minAgo(23 * 60 + 20), updated = minAgo(23 * 60 + 15), created = minAgo(23 * 60 + 45), tags = listOf("Urgente"))
        addMessage(Ids.C_40MIN, "customer", fernanda, "Olá! Meu pedido 4817 ainda não chegou e o prazo era ontem.", minAgo(23 * 60 + 40))
        addMessage(Ids.C_40MIN, "outbound", me, "Oi, Fernanda! Sinto muito pelo atraso. Já abri um chamado com a transportadora.", minAgo(23 * 60 + 30), "read")
        addMessage(Ids.C_40MIN, "customer", fernanda, "Preciso disso até sexta, é para um evento.", minAgo(23 * 60 + 20))
        addMessage(Ids.C_40MIN, "outbound", me, "Entendido. Te retorno hoje com a nova previsão de entrega.", minAgo(23 * 60 + 15), "delivered")

        // (4) minha, janela fechada
        val ricardo = "5531987651234"
        conversation(Ids.C_WINDOW_CLOSED, "Ricardo Santos", ricardo, "human", me, Ids.LINE_META, lastCustomer = hoursAgo(30.0), updated = hoursAgo(30.0), created = hoursAgo(31.0))
        addMessage(Ids.C_WINDOW_CLOSED, "customer", ricardo, "Vocês emitem nota fiscal para pessoa jurídica?", hoursAgo(31.0))
        addMessage(Ids.C_WINDOW_CLOSED, "outbound", me, "Emitimos sim, Ricardo. Só preciso do CNPJ e da inscrição estadual.", hoursAgo(30.8), "read")
        addMessage(Ids.C_WINDOW_CLOSED, "customer", ricardo, "Vou pegar com a contabilidade e te envio.", hoursAgo(30.0))

        // (5) fila, esperando há 12 min, setor Financeiro
        val patricia = "5511976543210"
        conversation(Ids.C_QUEUE, "Patrícia Lima", patricia, "waiting", null, Ids.LINE_META, lastCustomer = minAgo(12), updated = minAgo(12), created = minAgo(14), tags = listOf("Financeiro"), department = Ids.DEP_FINANCEIRO)
        addMessage(Ids.C_QUEUE, "customer", patricia, "Oi, preciso falar sobre uma cobrança duplicada no cartão.", minAgo(14))
        addMessage(Ids.C_QUEUE, "outbound", vendas, "Entendi, Patrícia. Vou encaminhar você para o setor Financeiro. Um atendente já vai falar com você.", minAgo(13), "read")
        addMessage(Ids.C_QUEUE, "system", "system", "Encaminhada para o setor Financeiro", minAgo(13))
        addMessage(Ids.C_QUEUE, "customer", patricia, "Ok, fico no aguardo.", minAgo(12))

        // (6) fila, esperando há 2 min
        val lucas = "5541999887766"
        conversation(Ids.C_QUEUE2, "Lucas Ferreira", lucas, "waiting", null, Ids.LINE_ZERNIO, lastCustomer = minAgo(2), updated = minAgo(2), created = minAgo(3))
        addMessage(Ids.C_QUEUE2, "customer", lucas, "Boa tarde!", minAgo(3))
        addMessage(Ids.C_QUEUE2, "customer", lucas, "Quero contratar o plano para 5 usuários. Com quem eu falo?", minAgo(2))

        // (7) com o bot Vendas
        val camila = "5511965432109"
        conversation(Ids.C_BOT, "Camila Rocha", camila, "ai", null, Ids.LINE_META, lastCustomer = minAgo(8), updated = minAgo(8), created = minAgo(11), bot = Ids.BOT_VENDAS)
        addMessage(Ids.C_BOT, "customer", camila, "Qual o horário de atendimento de vocês?", minAgo(11))
        addMessage(Ids.C_BOT, "outbound", vendas, "Oi, Camila! Atendemos de segunda a sexta, das 8h às 18h, e aos sábados das 9h às 13h. 😊", minAgo(10), "read")
        addMessage(Ids.C_BOT, "customer", camila, "E vocês têm teste grátis?", minAgo(8))
        addMessage(Ids.C_BOT, "outbound", vendas, "Temos sim: 14 dias com todos os recursos, sem cartão. Quer que eu crie o seu acesso agora?", minAgo(8), "delivered")

        // (8) com a Ana, setor Suporte
        val eduardo = "5519988776655"
        conversation(Ids.C_ANA, "Eduardo Ribeiro", eduardo, "human", Ids.ANA, Ids.LINE_ZERNIO, lastCustomer = minAgo(180), updated = minAgo(175), created = minAgo(200), tags = listOf("Suporte"), department = Ids.DEP_SUPORTE)
        addMessage(Ids.C_ANA, "customer", eduardo, "O QR code da integração não está aparecendo para mim.", minAgo(200))
        addMessage(Ids.C_ANA, "system", "system", "Conversa assumida por Ana Souza", minAgo(190))
        addMessage(Ids.C_ANA, "outbound", Ids.ANA, "Oi, Eduardo! Aqui é a Ana, do suporte. Você está no computador ou no celular?", minAgo(185), "read")
        addMessage(Ids.C_ANA, "customer", eduardo, "No computador, pelo Chrome.", minAgo(180))
        addMessage(Ids.C_ANA, "outbound", Ids.ANA, "Certo! Limpa o cache e tenta de novo, por favor. Se não aparecer, eu gero outro por aqui.", minAgo(175), "delivered")

        // (9) concluída
        val juliana = "5511954321098"
        conversation(Ids.C_DONE, "Juliana Mendes", juliana, "closed", null, Ids.LINE_META, lastCustomer = hoursAgo(47.0), updated = hoursAgo(46.7), created = hoursAgo(50.0))
        addMessage(Ids.C_DONE, "customer", juliana, "Não estou conseguindo entrar no painel, diz que a senha está errada.", hoursAgo(50.0))
        addMessage(Ids.C_DONE, "outbound", Ids.CARLOS, "Oi, Juliana! Enviei um link para redefinir a senha no seu e-mail.", hoursAgo(49.5), "read")
        addMessage(Ids.C_DONE, "customer", juliana, "Consegui acessar, muito obrigada pela ajuda!", hoursAgo(47.0))
        addMessage(Ids.C_DONE, "outbound", Ids.CARLOS, "Que bom! Qualquer coisa é só chamar. 😊", hoursAgo(46.8), "read")
        addMessage(Ids.C_DONE, "system", "system", "Conversa concluída por Carlos Pereira", hoursAgo(46.7))

        // (10) grupo, linha Zernio
        conversation(Ids.C_GROUP, "Condomínio Jardins", null, "human", me, Ids.LINE_ZERNIO, lastCustomer = minAgo(25), updated = minAgo(25), created = hoursAgo(200.0), tags = listOf("Condomínio"), group = true)
        val participants = listOf(
            j("id" to "5511970001111", "name" to "Sérgio (Síndico)", "admin" to true),
            j("id" to "5511970002222", "name" to "Helena · Bloco B", "admin" to false),
            j("id" to "5511970003333", "name" to "Dona Lúcia", "admin" to false),
            j("id" to "5511970004444", "name" to "Marcos Portaria", "admin" to false),
        )
        groups[Ids.C_GROUP] = j("id" to Ids.C_GROUP, "subject" to "Condomínio Jardins", "announcement" to false, "participants" to JsonArray(participants).toString())
        fun member(index: Int) = j("type" to "text", "participant" to participants[index].str("id"), "participant_name" to participants[index].str("name"))
        addMessage(Ids.C_GROUP, "customer", "5511970001111", "Pessoal, a manutenção do portão ficou para quinta-feira.", minAgo(40), content = member(0))
        addMessage(Ids.C_GROUP, "customer", "5511970002222", "Bruno, consegue confirmar o horário com a empresa?", minAgo(35), content = member(1))
        addMessage(Ids.C_GROUP, "outbound", me, "Confirmado: quinta, das 9h às 12h. O portão de pedestres continua funcionando normalmente.", minAgo(30), "read")
        addMessage(Ids.C_GROUP, "customer", "5511970003333", "Obrigada pelo aviso! 🙏", minAgo(26), content = member(2))
        addMessage(Ids.C_GROUP, "customer", "5511970001111", "Perfeito, vou colocar no mural também.", minAgo(25), content = member(0))
    }

    private fun seedTickets() {
        fun ticket(id: String, number: String, conversation: String, title: String, status: String, owner: String?, due: Long?, firstResponse: Long?, created: Long, updated: Long, category: String? = null) {
            tickets[id] = row(
                "id" to id, "number" to number, "profile_id" to Ids.PROFILE, "conversation_id" to conversation, "title" to title,
                "status" to status, "owner" to owner, "response_due_at" to due, "first_response_at" to firstResponse,
                "created" to created, "updated" to updated, "category" to category,
            )
            ticketUpdates[id] = ArrayList()
        }
        fun update(ticketId: String, actor: String, text: String, at: Long, internal: Boolean = false) {
            val list = ticketUpdates.getOrPut(ticketId) { ArrayList() }
            list += row("id" to "tu-$ticketId-${list.size + 1}", "ticket_id" to ticketId, "actor" to actor, "text" to text, "internal" to if (internal) 1 else 0, "created" to at)
        }

        // Os seis estados (docs/CENTRAL-ATENDIMENTO.md §2), com categoria: Recebido (atrasado e vencendo), Em análise,
        // Aguardando cliente, Aguardando terceiro, Resolvido e Encerrado (este sem categoria).
        ticket(Ids.T_OVERDUE, "WA-2026-000181", Ids.C_5H, "Segunda via do boleto de outubro com o valor corrigido", "open", Ids.ME, hoursAgo(2.0), null, hoursAgo(18.9), hoursAgo(18.9), category = Ids.CAT_FAGOO)
        update(Ids.T_OVERDUE, "system", "Protocolo aberto por Bruno Almeida.", hoursAgo(18.9))
        update(Ids.T_OVERDUE, Ids.ME, "Financeiro precisa recalcular os juros antes de emitir a segunda via.", hoursAgo(18.5), internal = true)

        ticket(Ids.T_SOON, "WA-2026-000185", Ids.C_ANA, "QR code da integração não aparece no painel", "open", Ids.ANA, t0 + 40 * 60_000L, null, minAgo(170), minAgo(170), category = Ids.CAT_SERVIDOR)
        update(Ids.T_SOON, "system", "Protocolo aberto por Ana Souza.", minAgo(170))

        ticket(Ids.T_PROGRESS, "WA-2026-000184", Ids.C_RICH, "Migração do histórico do painel antigo", "in_progress", Ids.ME, t0 + 22 * 3_600_000L, null, minAgo(160), minAgo(95), category = Ids.CAT_WABOTIA)
        update(Ids.T_PROGRESS, "system", "Protocolo aberto por Bruno Almeida.", minAgo(160))
        update(Ids.T_PROGRESS, Ids.ME, "Cliente usa o painel antigo desde 2022. Confirmar com o suporte se a exportação em CSV traz os anexos.", minAgo(155), internal = true)
        update(Ids.T_PROGRESS, Ids.MARINA, "Suporte confirmou: a exportação traz mensagens e anexos. Precisamos do acesso de administrador do cliente.", minAgo(120))
        update(Ids.T_PROGRESS, Ids.ME, "Estamos preparando a migração do seu histórico. Assim que tivermos o acesso de administrador, concluímos em até 2 dias úteis.", minAgo(95))

        val answeredAt = messages[Ids.C_RICH]?.firstOrNull { it.str("attachments")?.contains(DemoMedia.PDF_ID) == true }?.long("created") ?: hoursAgo(20.0)
        ticket(Ids.T_ANSWERED, "WA-2026-000182", Ids.C_RICH, "Proposta do plano Empresarial para 20 atendentes", "waiting_customer", Ids.ME, answeredAt + 90 * 60_000L, answeredAt, answeredAt - 14 * 60_000L, answeredAt, category = Ids.CAT_WABOTIA)
        update(Ids.T_ANSWERED, "system", "Protocolo aberto por Bruno Almeida.", answeredAt - 14 * 60_000L)
        update(Ids.T_ANSWERED, Ids.ME, "Proposta enviada com o desconto de parceiro. Aguardando a confirmação do CNPJ para emitir o contrato.", answeredAt)

        ticket(Ids.T_THIRD, "WA-2026-000179", Ids.C_WINDOW_CLOSED, "Nota fiscal de serviço rejeitada pela prefeitura", "waiting_third", Ids.MARINA, hoursAgo(29.0), hoursAgo(30.5), hoursAgo(30.9), hoursAgo(26.0), category = Ids.CAT_NFSE)
        update(Ids.T_THIRD, "system", "Protocolo aberto por Marina Lopes.", hoursAgo(30.9))
        update(Ids.T_THIRD, Ids.MARINA, "Recebemos o retorno da prefeitura com o código da rejeição. Abrimos um chamado no portal do município.", hoursAgo(30.5))
        update(Ids.T_THIRD, Ids.MARINA, "Aguardando a prefeitura liberar o novo código de serviço.", hoursAgo(26.0), internal = true)

        ticket(Ids.T_RESOLVED, "WA-2026-000178", Ids.C_40MIN, "Etiquetas saindo cortadas na impressora térmica", "resolved", Ids.ANA, hoursAgo(40.0), hoursAgo(43.0), hoursAgo(44.0), hoursAgo(38.0), category = Ids.CAT_PRINTHER)
        update(Ids.T_RESOLVED, "system", "Protocolo aberto por Ana Souza.", hoursAgo(44.0))
        update(Ids.T_RESOLVED, Ids.ANA, "Ajustamos o tamanho da etiqueta no modelo de impressão. Pode testar com um pedido novo?", hoursAgo(43.0))
        update(Ids.T_RESOLVED, Ids.ANA, "Cliente confirmou que as etiquetas voltaram a sair inteiras.", hoursAgo(38.0))

        ticket(Ids.T_CLOSED, "WA-2026-000176", Ids.C_DONE, "Dificuldade de acesso ao painel", "closed", Ids.CARLOS, hoursAgo(48.0), hoursAgo(49.5), hoursAgo(49.9), hoursAgo(46.7))
        update(Ids.T_CLOSED, "system", "Protocolo aberto por Carlos Pereira.", hoursAgo(49.9))
        update(Ids.T_CLOSED, Ids.CARLOS, "Enviamos um link para redefinir a senha no e-mail cadastrado.", hoursAgo(49.5))
        update(Ids.T_CLOSED, Ids.CARLOS, "Acesso normalizado. Protocolo encerrado.", hoursAgo(46.7))
    }

    private fun seedBotRuns() {
        fun botRun(id: String, bot: String, actor: String, status: String, input: String, result: String?, error: String?, created: Long, conversation: String? = null) {
            botRuns += row(
                "id" to id, "profile_id" to Ids.PROFILE, "bot_id" to bot, "actor" to actor, "conversation_id" to conversation, "status" to status,
                "input" to input, "result" to result, "error" to error, "attachments" to emptyList<String>(), "created" to created, "updated" to created + 9_000L,
            )
        }
        botRun(
            "run-5", Ids.BOT_VENDAS, Ids.ME, "completed", "Resuma os pedidos em aberto da cliente 5511987654321.",
            "Mariana Costa tem 2 solicitações em aberto: a proposta do plano Empresarial (aguardando o CNPJ para o contrato) e a migração do histórico do painel antigo, com retorno prometido para amanhã.",
            null, hoursAgo(4.0), Ids.C_RICH,
        )
        botRun(
            "run-4", Ids.BOT_SUPORTE, Ids.ME, "completed", "Como configuro o webhook de entrega?",
            "No painel, abra Integrações › Webhooks, informe a URL HTTPS do seu sistema e marque os eventos message.sent e message.delivered. O Wabotia tenta de novo por até 24 horas quando o destino não responde.",
            null, hoursAgo(6.5),
        )
        botRun("run-3", Ids.BOT_SUPORTE, Ids.ME, "failed", "Gere o relatório de SLA da semana.", null, "O Hermes não respondeu a tempo. Tente novamente em instantes.", hoursAgo(25.0))
        botRun(
            "run-2", Ids.BOT_VENDAS, Ids.ME, "completed", "Monte o relatório de vendas de outubro.",
            j("text" to "Relatório de vendas de outubro pronto: 128 pedidos, faturamento de R$ 52.774,00 e ticket médio de R$ 412,30. A planilha completa está em anexo.", "attachments" to listOf(DemoMedia.REPORT_ID)).toString(),
            null, hoursAgo(27.0),
        )
        botRun(
            "run-1", Ids.BOT_VENDAS, Ids.ME, "completed", "Qual é o desconto máximo para o plano anual?",
            "Para o plano anual o desconto máximo é de 15%. Acima disso é preciso aprovação da gerência comercial.",
            null, hoursAgo(52.0),
        )
    }

    private fun seedCalls() {
        fun call(id: String, conversation: String, direction: String, actor: String?, status: String, created: Long, duration: Long?) {
            calls += row(
                "id" to id, "conversation_id" to conversation, "direction" to direction, "actor" to actor, "status" to status, "error" to null,
                "started" to if (duration != null) created + 8_000L else null,
                "ended" to if (duration != null) created + 8_000L + duration * 1000L else created + 30_000L,
                "duration" to duration, "created" to created, "updated" to created + 30_000L,
            )
        }
        call("call-1", Ids.C_RICH, "inbound", Ids.ME, "completed", hoursAgo(3.4), 185)
        call("call-2", Ids.C_5H, "inbound", null, "missed", hoursAgo(20.0), null)
        call("call-3", Ids.C_40MIN, "outbound", Ids.ME, "completed", hoursAgo(26.0), 62)
        call("call-4", Ids.C_ANA, "inbound", Ids.ANA, "rejected", hoursAgo(49.0), null)
    }

    /** Acrescenta uma ligação tocando (atalho `ringing`). */
    fun addRingingCall(now: Long) {
        if (calls.any { it.str("id") == Ids.CALL_RINGING }) return
        calls += row(
            "id" to Ids.CALL_RINGING, "conversation_id" to Ids.C_5H, "direction" to "inbound", "actor" to null, "status" to "ringing", "error" to null,
            "started" to null, "ended" to null, "duration" to null, "created" to now, "updated" to now,
        )
    }

    private fun seedInternalChats() {
        fun chat(id: String, peer: String, created: Long) {
            val members = listOf(Ids.ME, peer).sorted()
            chats[id] = row("id" to id, "profile_id" to Ids.PROFILE, "member_a" to members[0], "member_b" to members[1], "created" to created, "updated" to created)
            chatMessages[id] = ArrayList()
        }
        chat(Ids.CHAT_ANA, Ids.ANA, minAgo(60))
        addChatMessage(Ids.CHAT_ANA, Ids.ANA, "Bruno, a Mariana Costa voltou a falar com você?", minAgo(52))
        addChatMessage(Ids.CHAT_ANA, Ids.ME, "Voltou sim, estou fechando o contrato com ela agora.", minAgo(50))
        addChatMessage(Ids.CHAT_ANA, Ids.ANA, "Ótimo! Lembra de aplicar o desconto de parceiro, ela veio pela Fagoo.", minAgo(47))
        addChatMessage(Ids.CHAT_ANA, Ids.ME, "Boa, já coloquei na proposta. Obrigado pelo aviso!", minAgo(45))
        addChatMessage(Ids.CHAT_ANA, Ids.ME, "Você consegue pegar a Patrícia Lima da fila? É cobrança duplicada.", minAgo(11))
        addChatMessage(Ids.CHAT_ANA, Ids.ANA, "Pego sim, é só terminar este atendimento aqui. 👍", minAgo(9))

        val vendas = "bot:${Ids.BOT_VENDAS}"
        chat(Ids.CHAT_VENDAS, vendas, minAgo(95))
        addChatMessage(Ids.CHAT_VENDAS, Ids.ME, "Qual é o prazo de implantação do plano Empresarial?", minAgo(90))
        addChatMessage(Ids.CHAT_VENDAS, vendas, "A implantação do plano Empresarial leva até 5 dias úteis, já com a migração do histórico e o treinamento da equipe.", minAgo(89), status = "completed", runId = "run-interno-1")
    }

    fun addChatMessage(chatId: String, author: String, text: String, at: Long, status: String = "sent", runId: String? = null): Row {
        val list = chatMessages.getOrPut(chatId) { ArrayList() }
        val message = row("id" to "im-$chatId-${list.size + 1}", "author" to author, "text" to text, "created" to at, "status" to status, "run_id" to runId)
        list += message
        chats[chatId]?.assign("updated", at)
        return message
    }
}
