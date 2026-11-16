package br.com.queven.wabotia.modules

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.queven.wabotia.BuildConfig
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.WabotiaJson
import br.com.queven.wabotia.queue.QueueClient
import br.com.queven.wabotia.queue.QueueException
import br.com.queven.wabotia.queue.execute
import br.com.queven.wabotia.queue.normalizeBaseUrl
import br.com.queven.wabotia.queue.queueHttp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

/*
 * A base das telas das verticais (Agenda, Ordem de Serviço, Reserva, Mensalidade): as rotas de uma área com o token da
 * pessoa, o que o núcleo oferece a todos os módulos (estabelecimento, pessoas da área), a idempotência por intenção e
 * as regras de horário, telefone e dinheiro. Mesmo desenho do iOS (`Modules/ModuleAPI.swift`).
 */

private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()

/**
 * As rotas de uma área (`/api/v1/profiles/{p}/…`) com o token da pessoa. Recusas do contrato chegam como
 * [QueueException] (status, código e mensagem do servidor); `module_disabled` esconde a tela.
 */
class ProfileApi(
    baseUrl: String,
    val profileId: String,
    private val token: () -> String?,
    private val http: OkHttpClient = queueHttp(),
) {
    private val root = normalizeBaseUrl(baseUrl) + "/api/v1/profiles/" + profileId + "/"

    suspend fun <T> get(path: String, serializer: KSerializer<T>, query: Map<String, String?> = emptyMap()): T =
        WabotiaJson.decodeFromJsonElement(serializer, raw(path, query))

    /** A resposta crua, para quem lê um mapa com as chaves exatas (`counts`). */
    suspend fun raw(path: String, query: Map<String, String?> = emptyMap()): JsonElement = withContext(Dispatchers.IO) {
        execute(http, request(url(path, query)).get().build()) { WabotiaJson.parseToJsonElement(it.ifBlank { "{}" }) }
    }

    /** Escrita com `Idempotency-Key`; chaves com valor `null` ficam de fora (use [JsonNull] para mandar nulo). */
    suspend fun <T> send(method: String, path: String, body: JsonObject, key: String, serializer: KSerializer<T>): T =
        withContext(Dispatchers.IO) {
            val request = request(url(path, emptyMap()))
                .header("Idempotency-Key", key)
                .method(method, body.toString().toRequestBody(JSON_TYPE))
                .build()
            execute(http, request) { WabotiaJson.decodeFromString(serializer, it.ifBlank { "{}" }) }
        }

    /** Dados do estabelecimento da área (cabeçalho e rodapé dos comprovantes). */
    suspend fun establishment(): Establishment = get("establishment", Establishment.serializer())

    /** Pessoas da área, para escolher o responsável de um registro de módulo. */
    suspend fun people(): List<AreaPerson> = get("people", DataList.serializer(AreaPerson.serializer())).data

    private fun url(path: String, query: Map<String, String?>): String {
        val builder = (root + path).toHttpUrl().newBuilder()
        query.entries.filter { it.value != null }.sortedBy { it.key }.forEach { builder.addQueryParameter(it.key, it.value) }
        return builder.build().toString()
    }

    private fun request(url: String): Request.Builder =
        Request.Builder().url(url)
            .header("Accept", "application/json")
            .header("User-Agent", "Wabotia-Android/${BuildConfig.VERSION_NAME}")
            .apply { token()?.takeIf { it.isNotBlank() }?.let { header("Authorization", "Bearer $it") } }

    companion object {
        /** Com a sessão de pessoa do app. */
        fun current(container: AppContainer): ProfileApi =
            ProfileApi(container.session.serverUrl.orEmpty(), container.session.profileId.orEmpty(), { container.session.token })
    }
}

/** `{data: [...]}`. */
@Serializable
data class DataList<T>(val data: List<T> = emptyList())

/** Monta o corpo JSON: `null` some, [JsonNull] vai como nulo; listas e mapas viram arrays e objetos. */
fun jsonBody(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(pairs.mapNotNull { (k, v) -> toJson(v)?.let { k to it } }.toMap())

private fun toJson(value: Any?): JsonElement? = when (value) {
    null -> null
    is JsonElement -> value
    is String -> JsonPrimitive(value)
    is Boolean -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is Map<*, *> -> JsonObject(value.entries.mapNotNull { (k, v) -> toJson(v)?.let { k.toString() to it } }.toMap())
    is Iterable<*> -> JsonArray(value.mapNotNull { toJson(it) })
    else -> JsonPrimitive(value.toString())
}

/**
 * Nome fantasia, documento, endereço, telefone e rodapé da área (Gestão → Estabelecimento). Sem cadastro,
 * `configured` é falso e `name` é o nome da área.
 */
@Serializable
data class Establishment(
    val name: String? = null,
    val document: String? = null,
    @SerialName("document_type") val documentType: String? = null,
    @SerialName("document_display") val documentDisplay: String? = null,
    val address: String? = null,
    val phone: String? = null,
    val footer: String? = null,
    val configured: Boolean? = null,
) {
    /**
     * As linhas do cabeçalho do comprovante, depois do nome: documento, endereço (pode ter quebras) e telefone. O
     * cupom do totem vai para desconhecidos: o CPF (MEI ou autônomo que cadastrou o próprio) sai mascarado; o CNPJ,
     * que é público, sai inteiro.
     */
    val headerLines: List<String>
        get() = buildList {
            documentLine?.let(::add)
            address.orEmpty().lines().map { it.trim() }.filter { it.isNotEmpty() }.forEach(::add)
            phone?.trim()?.takeIf { it.isNotEmpty() }?.let(::add)
        }

    /** "CNPJ 11.222.333/0001-81" ou "CPF ***.456.789-**"; um CPF que não dá para mascarar fica de fora. */
    private val documentLine: String?
        get() {
            val shown = documentDisplay?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val digits = shown.filter(Char::isDigit).ifEmpty { document.orEmpty().filter(Char::isDigit) }
            val isCpf = documentType == "cpf" || (documentType != "cnpj" && digits.length == 11)
            if (!isCpf) return "CNPJ $shown"
            return maskCpf(digits)?.let { "CPF $it" }
        }

    val footerLines: List<String> get() = footer.orEmpty().lines().map { it.trim() }.filter { it.isNotEmpty() }

    val displayName: String? get() = name?.trim()?.takeIf { it.isNotEmpty() }

    companion object {
        /** "12345678909" → "***.456.789-**": só os seis dígitos do meio, como na divulgação de dados pessoais. */
        fun maskCpf(digits: String): String? =
            digits.takeIf { it.length == 11 && it.all(Char::isDigit) }?.let { "***.${it.substring(3, 6)}.${it.substring(6, 9)}-**" }
    }
}

/** Pessoa da área (`GET /people`): `id` é o valor de `assignee`. */
@Serializable
data class AreaPerson(val id: String, val name: String? = null, val role: String? = null) {
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: "Pessoa"
}

/**
 * Uma `Idempotency-Key` por intenção (mobile/README.md): sem resposta (rede, 5xx), a mesma intenção repete com a mesma
 * chave até o servidor confirmar; sucesso ou recusa definitiva liberam a chave, e a próxima intenção ganha outra.
 */
class IntentKeys {
    private var pending: Pair<String, String>? = null

    fun key(signature: String): String {
        pending?.let { (sig, key) -> if (sig == signature) return key }
        return QueueClient.newKey().also { pending = signature to it }
    }

    /** Depois da resposta: só uma falha repetível guarda a chave. */
    fun settle(error: Throwable?) {
        if (error is QueueException && error.retryable) return
        if (error != null && error !is QueueException) return
        pending = null
    }

    val pendingKey: String? get() = pending?.second
}

/**
 * Dia e hora de Brasília: os módulos guardam ms Unix e mostram o horário de Brasília, qualquer que seja o fuso do
 * aparelho.
 */
object BrasiliaTime {
    val zone: ZoneId = ZoneId.of("America/Sao_Paulo")
    private val locale = Locale.forLanguageTag("pt-BR")
    private val dayFormat = DateTimeFormatter.ISO_LOCAL_DATE
    private val clockFormat = DateTimeFormatter.ofPattern("HH:mm", locale)
    private val shortFormat = DateTimeFormatter.ofPattern("dd/MM/yyyy", locale)
    private val shortTimeFormat = DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm", locale)
    private val longFormat = DateTimeFormatter.ofPattern("EEEE, d 'de' MMMM", locale)
    private val compactFormat = DateTimeFormatter.ofPattern("EEE d/MM", locale)
    private val monthFormat = DateTimeFormatter.ofPattern("MMMM 'de' yyyy", locale)

    private fun local(millis: Long) = Instant.ofEpochMilli(millis).atZone(zone)

    /** "2026-11-22" do instante, em Brasília. */
    fun day(millis: Long): String = local(millis).toLocalDate().format(dayFormat)

    fun today(now: Long = System.currentTimeMillis()): String = day(now)

    fun parse(day: String): LocalDate? = runCatching { LocalDate.parse(day, dayFormat) }.getOrNull()

    /** Meia-noite de Brasília do dia "AAAA-MM-DD", em ms. */
    fun startOf(day: String): Long? = parse(day)?.atStartOfDay(zone)?.toInstant()?.toEpochMilli()

    fun addDays(day: String, n: Int): String = parse(day)?.plusDays(n.toLong())?.format(dayFormat) ?: day

    /** `[início, fim)` em ms dos dias `day` a `day + days - 1`. */
    fun range(day: String, days: Int = 1): Pair<Long, Long>? {
        val start = parse(day) ?: return null
        return start.atStartOfDay(zone).toInstant().toEpochMilli() to start.plusDays(days.toLong()).atStartOfDay(zone).toInstant().toEpochMilli()
    }

    /** A segunda-feira da semana do dia. */
    fun weekStart(day: String): String = parse(day)?.let { it.minusDays((it.dayOfWeek.value - 1).toLong()).format(dayFormat) } ?: day

    /** Dias entre dois "AAAA-MM-DD" (fim menos início). */
    fun daysBetween(from: String, to: String): Long? {
        val a = parse(from) ?: return null
        val b = parse(to) ?: return null
        return ChronoUnit.DAYS.between(a, b)
    }

    fun clock(millis: Long): String = local(millis).format(clockFormat)

    fun short(millis: Long): String = local(millis).format(shortFormat)

    fun shortWithTime(millis: Long): String = local(millis).format(shortTimeFormat)

    /** "22/11/2026" de "2026-11-22". */
    fun shortDay(day: String): String = parse(day)?.format(shortFormat) ?: day

    /** "Sábado, 22 de novembro" (com "Hoje"/"Amanhã" quando cabe). */
    fun title(day: String, now: Long = System.currentTimeMillis()): String {
        val date = parse(day) ?: return day
        val text = date.format(longFormat).replaceFirstChar { it.titlecase(locale) }
        return when (day) {
            today(now) -> "Hoje · $text"
            addDays(today(now), 1) -> "Amanhã · $text"
            else -> text
        }
    }

    /** "sáb 22/11". */
    fun compact(day: String): String = parse(day)?.format(compactFormat) ?: day

    /** "Novembro de 2026" de "2026-11". */
    fun month(month: String): String =
        runCatching { LocalDate.parse("$month-01", dayFormat).format(monthFormat).replaceFirstChar { it.titlecase(locale) } }.getOrDefault(month)

    /** "2026-11" do instante. */
    fun currentMonth(now: Long = System.currentTimeMillis()): String = day(now).take(7)

    fun addMonths(month: String, n: Int): String =
        runCatching { LocalDate.parse("$month-01", dayFormat).plusMonths(n.toLong()).format(dayFormat).take(7) }.getOrDefault(month)
}

/** Telefone para mostrar: "5520906543210" → "(20) 90654-3210"; fora do Brasil, "+" e os dígitos. */
object PhoneText {
    fun display(value: String?): String? {
        val d = value?.filter(Char::isDigit)?.takeIf { it.isNotEmpty() } ?: return null
        if (!d.startsWith("55") || d.length < 12) return "+$d"
        val local = d.drop(2)
        val ddd = local.take(2)
        val rest = local.drop(2)
        return "($ddd) ${rest.dropLast(4)}-${rest.takeLast(4)}"
    }
}

/** Dinheiro em centavos. */
object Money {
    /** "R$ 1.234,56". */
    fun format(cents: Long): String {
        val negative = cents < 0
        val abs = kotlin.math.abs(cents)
        val reais = (abs / 100).toString().reversed().chunked(3).joinToString(".").reversed()
        return "${if (negative) "-" else ""}R$ $reais,${(abs % 100).toString().padStart(2, '0')}"
    }

    fun format(cents: Int): String = format(cents.toLong())

    /** "45", "45,9", "1.234,56", "R$ 12,00" → centavos; `null` quando não é valor. */
    fun parse(text: String): Long? {
        val t = text.replace("R$", "").trim().replace(".", "")
        if (t.isEmpty()) return null
        val parts = t.split(",")
        if (parts.size > 2) return null
        val reais = (parts[0].ifEmpty { "0" }).toLongOrNull()?.takeIf { it >= 0 } ?: return null
        var cents = 0L
        if (parts.size == 2) {
            val frac = parts[1]
            if (frac.length > 2 || !frac.all(Char::isDigit)) return null
            cents = frac.padEnd(2, '0').ifEmpty { "00" }.toLong()
        }
        return reais * 100 + cents
    }
}

/** O que fazer com uma recusa que vale para o app inteiro: 401 volta ao login, 409 `module_disabled` esconde o módulo. */
object ModuleFailure {
    const val DISABLED_MESSAGE = "Este módulo está desligado neste Wabotia. Um administrador liga em Gestão → Módulos."
    const val RETRY_HINT = " Toque de novo para repetir com segurança."

    fun handle(container: AppContainer, module: String, error: Throwable) {
        val e = error as? QueueException ?: return
        if (e.unauthorized) container.onLoggedOut(keepServer = true)
        if (e.moduleDisabled) container.modules.markDisabled(module)
        if (e.accessDenied) container.modules.accessDenied()
    }

    fun message(error: Throwable): String = when {
        error is QueueException && error.moduleDisabled -> DISABLED_MESSAGE
        error is QueueException -> error.message ?: "O Wabotia recusou."
        else -> error.message ?: "Algo deu errado."
    }

    /** A mensagem e, numa falha de rede, o aviso de que tocar de novo repete com a mesma chave. */
    fun actionMessage(error: Throwable): String =
        message(error) + if ((error as? QueueException)?.retryable == true) RETRY_HINT else ""
}

val QueueException.moduleDisabled: Boolean get() = status == 409 && code == "module_disabled"

/** A pessoa não acessa isto (acesso por pessoa): esconder e reler `/capabilities`. */
val QueueException.accessDenied: Boolean get() = status == 403 && code == "access_denied"

/**
 * Atualização por eventos (`GET /events`, já consultado pelo app a cada 4 s): enquanto a tela está aberta, recarrega
 * quando chega um evento do módulo (`agenda.*`, `os.*`…), com uma pausa curta para juntar uma rajada numa leitura só.
 * `module.changed` relê as capacidades (o módulo pode ter sido desligado).
 */
fun ViewModel.observeModuleEvents(container: AppContainer, prefix: String, reload: suspend () -> Unit): Job =
    viewModelScope.launch {
        container.events.events
            .filter { list -> list.any { it.kind.startsWith(prefix) || it.kind == "module.changed" } }
            .collectLatest { list ->
                if (list.any { it.kind == "module.changed" }) {
                    container.modules.invalidate()
                    container.modules.refresh(force = true)
                }
                delay(300)
                reload()
            }
    }
