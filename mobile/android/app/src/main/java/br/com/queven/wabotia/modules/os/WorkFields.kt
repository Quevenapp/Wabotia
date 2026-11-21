package br.com.queven.wabotia.modules.os

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import java.math.BigDecimal
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle

/**
 * Os campos próprios de um modelo ou de um tipo de objeto, sem tela: o que aparece, o que é obrigatório, como validar
 * o que a pessoa digitou (as mesmas regras e mensagens de `parseExtra` do painel) e como mostrar um valor. Campos
 * `sensitive` têm fluxo próprio no painel: aqui nunca aparecem nem vão no corpo.
 *
 * O rascunho é texto por campo: número como digitado ("12,5"), Sim/Não como "true"/"false", data "AAAA-MM-DD",
 * escolha pelo id da opção; vazio é "".
 */
object WorkFields {
    private val strictDay: DateTimeFormatter = DateTimeFormatter.ofPattern("uuuu-MM-dd").withResolverStyle(ResolverStyle.STRICT)
    private val shownDay: DateTimeFormatter = DateTimeFormatter.ofPattern("dd/MM/yyyy")
    private val numberPattern = Regex("""^-?\d+(?:\.\d+)?$""")
    private val dayPattern = Regex("""^\d{4}-\d{2}-\d{2}$""")

    /** Só os campos comuns (nunca os sensíveis). */
    fun common(fields: List<WorkField>): List<WorkField> = fields.filter { !it.sensitive && it.id.isNotBlank() }

    /** Obrigatórios só pela definição do campo (objeto do serviço, edição). */
    fun required(fields: List<WorkField>): Set<String> = common(fields).filter { it.required }.map { it.id }.toSet()

    /**
     * Obrigatórios na abertura: o campo é obrigatório ou uma regra de etapa o pede desde a etapa inicial do modelo.
     */
    fun requiredAtOpening(type: WorkType): Set<String> {
        val fromRules = type.stageFieldRules.filter { it.requiredFromStage != null && it.requiredFromStage == type.initialStage }.map { it.fieldId }.toSet()
        return common(type.fields).filter { it.required || it.id in fromRules }.map { it.id }.toSet()
    }

    /**
     * Campos que a próxima etapa vai pedir: a regra exige o campo a partir de uma etapa oferecida em `next_stages` (fora
     * o cancelamento) ou ao sair da etapa atual. Sem o modelo, nada é marcado.
     */
    fun neededNext(type: WorkType?, order: WorkOrder): Set<String> {
        if (type == null) return emptySet()
        val nextStages = order.nextStages.filter { it.baseStatus != "cancelled" }.map { it.stage }.toSet()
        return type.stageFieldRules.filter { rule ->
            (rule.requiredFromStage != null && rule.requiredFromStage in nextStages) || (order.stage != null && order.stage in rule.requiredOnExit)
        }.map { it.fieldId }.toSet()
    }

    /** O rascunho a partir dos valores guardados (só campos comuns). */
    fun draftOf(fields: List<WorkField>, values: JsonObject): Map<String, String> =
        common(fields).associate { field -> field.id to draftText(field, values[field.id]) }

    private fun draftText(field: WorkField, value: JsonElement?): String {
        val p = value as? JsonPrimitive ?: return ""
        if (p is JsonNull) return ""
        return when (field.kind) {
            "boolean" -> p.booleanOrNull?.toString() ?: ""
            "decimal" -> p.content.replace('.', ',')
            else -> p.content
        }
    }

    /** Resultado da validação: os valores prontos para o corpo, ou a mensagem do primeiro problema. */
    sealed class Parsed {
        data class Ok(val values: JsonObject) : Parsed()
        data class Invalid(val fieldId: String, val message: String) : Parsed()
    }

    /**
     * Valida o rascunho na ordem dos campos. Campos vazios ficam fora do corpo, a não ser que tivessem valor em [base]
     * (a pessoa apagou): esses vão como nulo explícito. Sensíveis nunca entram, mesmo que estejam no rascunho.
     */
    fun parse(
        fields: List<WorkField>,
        draft: Map<String, String>,
        required: Set<String> = required(fields),
        base: JsonObject = JsonObject(emptyMap()),
    ): Parsed {
        val out = LinkedHashMap<String, JsonElement>()
        for (field in common(fields)) {
            val raw = draft[field.id]
            if (raw == null || raw.isBlank()) {
                if (field.id in required) return Parsed.Invalid(field.id, "${field.label}: preenchimento obrigatório.")
                val had = base[field.id]
                if (had != null && had !is JsonNull) out[field.id] = JsonNull
                continue
            }
            when (val checked = check(field, raw)) {
                is Check.Bad -> return Parsed.Invalid(field.id, checked.message)
                is Check.Good -> out[field.id] = checked.value
            }
        }
        return Parsed.Ok(JsonObject(out))
    }

    private sealed class Check {
        data class Good(val value: JsonElement) : Check()
        data class Bad(val message: String) : Check()
    }

    private fun check(field: WorkField, raw: String): Check {
        val label = field.label
        return when (field.kind) {
            "integer", "decimal" -> {
                val text = raw.trim().replace(",", ".")
                if (!numberPattern.matches(text)) return Check.Bad("$label: número inválido.")
                val number = text.toBigDecimalOrNull() ?: return Check.Bad("$label: número inválido.")
                val min = field.min?.doubleOrNull
                val max = field.max?.doubleOrNull
                val decimals = text.substringAfter('.', "").length
                val whole = number.stripTrailingZeros().scale() <= 0
                val outOfRange = (min != null && number < BigDecimal.valueOf(min)) || (max != null && number > BigDecimal.valueOf(max))
                val badShape = if (field.kind == "integer") !whole || number.abs() > BigDecimal.valueOf(9_007_199_254_740_991L) else decimals > (field.scale ?: 0)
                if (outOfRange || badShape) return Check.Bad("$label: confira limites e casas decimais.")
                Check.Good(if (whole) JsonPrimitive(number.toLong()) else JsonPrimitive(number.toDouble()))
            }
            "date" -> {
                val text = raw.trim()
                val parsed = if (dayPattern.matches(text)) runCatching { LocalDate.parse(text, strictDay) }.getOrNull() else null
                val min = field.min?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
                val max = field.max?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
                if (parsed == null || (min != null && text < min) || (max != null && text > max)) Check.Bad("$label: data inválida.") else Check.Good(JsonPrimitive(text))
            }
            "choice" -> if (field.options.any { it.id == raw }) Check.Good(JsonPrimitive(raw)) else Check.Bad("$label: escolha uma opção válida.")
            "boolean" -> when (raw) {
                "true" -> Check.Good(JsonPrimitive(true))
                "false" -> Check.Good(JsonPrimitive(false))
                else -> Check.Bad("$label: escolha Sim ou Não.")
            }
            else -> {
                val text = raw.trim()
                val limit = field.maxLength
                if (limit != null && text.codePointCount(0, text.length) > limit) Check.Bad("$label: texto fora do limite.") else Check.Good(JsonPrimitive(text))
            }
        }
    }

    /** O valor para mostrar: Sim/Não, o rótulo da opção, data dd/MM/aaaa, número com vírgula; vazio é "—". */
    fun display(field: WorkField, value: JsonElement?): String {
        if (field.sensitive) return "—"
        val p = value as? JsonPrimitive ?: return "—"
        if (p is JsonNull) return "—"
        val text = p.content
        if (text.isBlank()) return "—"
        return when (field.kind) {
            "boolean" -> when (p.booleanOrNull) { true -> "Sim"; false -> "Não"; null -> text }
            "choice" -> field.options.firstOrNull { it.id == text }?.label?.takeIf { it.isNotBlank() } ?: text
            "decimal" -> text.replace('.', ',')
            "date" -> runCatching { LocalDate.parse(text, strictDay).format(shownDay) }.getOrDefault(text)
            else -> text
        }
    }

    /** As linhas "rótulo: valor" dos campos comuns, na ordem da definição. */
    fun lines(fields: List<WorkField>, values: JsonObject): List<Pair<WorkField, String>> =
        common(fields).map { it to display(it, values[it.id]) }
}
