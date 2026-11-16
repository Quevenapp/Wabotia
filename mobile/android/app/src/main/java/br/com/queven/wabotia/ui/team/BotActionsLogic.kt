package br.com.queven.wabotia.ui.team

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.model.Approval
import br.com.queven.wabotia.core.model.ApprovalAdjust
import br.com.queven.wabotia.core.model.BotProposal
import br.com.queven.wabotia.core.model.display
import br.com.queven.wabotia.core.net.ApiException
import br.com.queven.wabotia.modules.Money
import br.com.queven.wabotia.ui.components.handleError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Ponto de encaixe do segundo fator (contrato completo em feat/login-mfa, da sessão A): a confirmação que responde
 * `403 mfa_required` pede o código do autenticador, este envio sobe a sessão para aal2 por um tempo, e a ação se repete.
 * Não há token por operação.
 */
fun interface MfaChallenger {
    suspend fun submit(code: String)
}

/** `POST /api/v1/account/mfa/challenge` com `{code}` (6 dígitos) ou `{recovery_code}` (o resto). */
class ApiMfaChallenger(private val container: AppContainer) : MfaChallenger {
    override suspend fun submit(code: String) {
        container.api.mfaChallenge(BotActionTexts.mfaBody(code))
    }
}

/** O que fazer com cada recusa das rotas de proposta e de aprovação (tabelas de erro do contrato). */
enum class BotActionError {
    MFA, PROPOSAL_EXPIRED, PROPOSAL_DECIDED, GONE, APPROVAL_CLOSED, APPROVAL_EXPIRED, FORBIDDEN, PERSON_REQUIRED, INVALID, OTHER;

    companion object {
        fun of(e: Throwable): BotActionError {
            val a = e as? ApiException ?: return OTHER
            return when {
                a.status == 403 && a.code == "mfa_required" -> MFA
                a.code == "proposal_expired" -> PROPOSAL_EXPIRED
                a.code == "proposal_cancelled" || a.code == "proposal_closed" -> PROPOSAL_DECIDED
                a.code == "approval_closed" -> APPROVAL_CLOSED
                a.code == "approval_expired" -> APPROVAL_EXPIRED
                a.code == "person_required" -> PERSON_REQUIRED
                a.status == 404 -> GONE
                a.status == 403 -> FORBIDDEN
                a.status == 400 || a.status == 422 -> INVALID
                else -> OTHER
            }
        }
    }
}

/** Textos dos cartões, sem Compose, para testar. */
object BotActionTexts {
    fun proposalStatus(status: String) = when (status) {
        "pending" -> "Aguardando você"
        "running" -> "Executando…"
        "done" -> "Feito"
        "failed" -> "Não foi possível"
        "cancelled" -> "Cancelada"
        "expired" -> "Venceu"
        else -> status
    }

    fun approvalStatus(status: String) = when (status) {
        "pending" -> "Aguardando a equipe"
        "deciding" -> "Em decisão"
        "approved" -> "Aprovado"
        "declined" -> "Recusado"
        "handoff" -> "Conversa assumida"
        "expired" -> "Venceu"
        else -> status
    }

    /** "Vence em 7 min" / "Vence em menos de 1 min" / null quando já passou ou não há prazo. */
    fun countdown(expiresAt: Long?, now: Long): String? {
        val left = (expiresAt ?: return null) - now
        if (left <= 0) return null
        val minutes = left / 60_000
        return if (minutes < 1) "Vence em menos de 1 min" else "Vence em $minutes min"
    }

    /** A proposta pendente que já passou do prazo aparece como vencida, mesmo antes de a conversa ser relida. */
    fun effectiveStatus(p: BotProposal, now: Long): String = if (p.status == "pending" && p.expiresAt != null && p.expiresAt <= now) "expired" else p.status

    fun params(params: JsonObject?): List<Pair<String, String>> = params.orEmpty().map { (k, v) -> k to v.display() }

    /** O que foi feito ou o erro, numa linha. */
    fun outcome(p: BotProposal): String? = when (p.status) {
        "failed" -> p.error?.let { e -> ((e as? JsonObject)?.get("message") ?: e).display() }
        "done" -> p.result?.let { r -> ((r as? JsonObject)?.get("message") ?: r).display() }?.takeIf { it != "—" }
        else -> null
    }

    /** "Aprovado por Ana · R$ 6,20 · cliente frequente". */
    fun decided(a: Approval, money: Boolean): String? {
        val who = a.decidedByName ?: return null
        val value = a.value?.let { if (money) Money.format(Math.round(it * 100)) else it.display() }
        return listOfNotNull("${approvalStatus(a.status)} por $who", value, a.reason?.takeIf { it.isNotBlank() }).joinToString(" · ")
    }

    private fun Double.display() = if (this % 1.0 == 0.0) toLong().toString() else toString().replace('.', ',')

    /**
     * O ajuste digitado: vazio é "sem ajuste" (Result com null); fora de [ApprovalAdjust.min]..[ApprovalAdjust.max] ou
     * ilegível é erro com o texto para a tela. Dinheiro em reais ("6,20").
     */
    fun parseAdjust(text: String, adjust: ApprovalAdjust?): kotlin.Result<Double?> {
        val raw = text.trim()
        if (raw.isEmpty() || adjust == null) return kotlin.Result.success(null)
        val value = (if (adjust.type == "money") Money.parse(raw)?.let { it / 100.0 } else raw.replace(',', '.').toDoubleOrNull())
            ?: return kotlin.Result.failure(IllegalArgumentException("Valor inválido."))
        if (adjust.min != null && value < adjust.min || adjust.max != null && value > adjust.max) {
            return kotlin.Result.failure(IllegalArgumentException("Use um valor entre ${bound(adjust.min, adjust)} e ${bound(adjust.max, adjust)}."))
        }
        return kotlin.Result.success(value)
    }

    private fun bound(v: Double?, adjust: ApprovalAdjust) = when {
        v == null -> "—"
        adjust.type == "money" -> Money.format(Math.round(v * 100))
        else -> v.display()
    }

    fun mfaBody(code: String): JsonObject {
        val clean = code.trim()
        return buildJsonObject { if (clean.length == 6 && clean.all(Char::isDigit)) put("code", clean) else put("recovery_code", clean) }
    }

    fun message(error: BotActionError): String? = when (error) {
        BotActionError.PROPOSAL_EXPIRED -> "A proposta venceu (vale 10 minutos). Peça de novo ao bot."
        BotActionError.PROPOSAL_DECIDED -> "Esta proposta já foi decidida."
        BotActionError.GONE -> "Esta proposta não é mais sua."
        BotActionError.APPROVAL_CLOSED -> "Outra pessoa decidiu primeiro."
        BotActionError.APPROVAL_EXPIRED -> "O prazo deste pedido venceu."
        BotActionError.FORBIDDEN -> "Você não pode decidir este pedido. Ele continua pendente para outra pessoa."
        BotActionError.PERSON_REQUIRED -> "Só uma pessoa logada pode decidir."
        else -> null
    }
}

/**
 * As ações dos cartões (confirmar e cancelar propostas; aprovar, recusar e assumir pedidos), compartilhadas pela conversa
 * interna e pela tela do pedido de aprovação aberta pelo push. [reload] relê depois de cada decisão (o estado vem atual
 * na leitura); [openConversation] abre a conversa do cliente depois de "Assumir".
 */
class BotActionsController(
    private val container: AppContainer,
    private val profile: String,
    private val scope: CoroutineScope,
    private val reload: suspend () -> Unit,
    private val openConversation: (String) -> Unit,
    private val mfa: MfaChallenger = ApiMfaChallenger(container),
) {
    /** Id da proposta ou do pedido com ação em curso. */
    var busy by mutableStateOf<String?>(null); private set
    var notice by mutableStateOf<String?>(null); private set
    /** A ação que pediu o segundo fator: o diálogo do código aparece enquanto não for nula. */
    var mfaPending by mutableStateOf(false); private set
    var mfaError by mutableStateOf<String?>(null); private set
    private var retry: (suspend () -> Unit)? = null

    fun consumeNotice() { notice = null }

    fun confirm(chatId: String, proposalId: String) = run(proposalId) {
        container.api.confirmProposal(profile, chatId, proposalId, "confirm:$proposalId", JsonObject(emptyMap()))
    }

    fun cancel(chatId: String, proposalId: String) = run(proposalId) {
        container.api.cancelProposal(profile, chatId, proposalId, "cancel:$proposalId", JsonObject(emptyMap()))
    }

    fun decide(approval: Approval, decision: String, value: Double? = null, reason: String? = null) = run(approval.id) {
        val body = buildJsonObject {
            put("decision", decision)
            value?.let { put("value", it) }
            reason?.trim()?.takeIf { it.isNotEmpty() }?.let { put("reason", it) }
        }
        val decided = container.api.decideApproval(profile, approval.id, "decide:${approval.id}:$decision", body)
        if (decision == "handoff") (decided.conversationId ?: approval.conversationId)?.let(openConversation)
    }

    fun submitMfa(code: String) {
        val action = retry ?: return
        if (code.isBlank()) return
        scope.launch {
            try {
                mfa.submit(code)
                mfaPending = false
                mfaError = null
                retry = null
                action()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                mfaError = (e as? ApiException)?.message ?: "Código não aceito. Confira e tente de novo."
            }
        }
    }

    fun dismissMfa() {
        mfaPending = false
        mfaError = null
        retry = null
    }

    private fun run(id: String, block: suspend () -> Unit) {
        if (busy != null) return
        lateinit var attempt: suspend () -> Unit
        attempt = {
            busy = id
            try {
                block()
                reload()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                when (val kind = BotActionError.of(e)) {
                    BotActionError.MFA -> {
                        retry = attempt
                        mfaPending = true
                    }
                    BotActionError.OTHER, BotActionError.INVALID -> notice = container.handleError(e)
                    else -> {
                        notice = BotActionTexts.message(kind)
                        runCatching { reload() }
                    }
                }
            } finally {
                busy = null
            }
        }
        scope.launch { attempt() }
    }
}
