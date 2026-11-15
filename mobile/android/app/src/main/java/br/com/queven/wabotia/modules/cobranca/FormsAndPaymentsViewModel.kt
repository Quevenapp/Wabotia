package br.com.queven.wabotia.modules.cobranca

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.modules.IntentKeys
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.modules.Money
import br.com.queven.wabotia.modules.ProfileApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** As dependências de "Enviar formulário" e "Cobrar" (trocáveis nos testes). [onFailure] recebe o módulo da recusa. */
class FormsPaymentsDeps(
    val client: FormsPaymentsClient,
    val onFailure: (module: String, error: Throwable) -> Unit,
) {
    companion object {
        fun of(container: AppContainer) = FormsPaymentsDeps(
            FormsPaymentsClient(ProfileApi.current(container)),
            { module, error -> ModuleFailure.handle(container, module, error) },
        )
    }
}

/**
 * "Enviar formulário" (módulo `forms`) e "Cobrar" (módulo `payments`) numa conversa: a lista de formulários ativos, o
 * envio com Idempotency-Key por intenção e as recusas do servidor (`payments_not_configured`, `window_closed`,
 * `module_disabled`, `form_disabled`). O estado de cada link e de cada cobrança vem do detalhe da conversa.
 */
class FormsPaymentsViewModel(val conversationId: String, private val deps: FormsPaymentsDeps) : ViewModel() {
    var forms by mutableStateOf<List<FormSummary>?>(null)
        private set
    var formsError by mutableStateOf<String?>(null)
        private set
    /** `form` ou `charge` em andamento. */
    var busy by mutableStateOf<String?>(null)
        private set
    /** Recusa da última ação, mostrada na folha aberta (sem fechá-la). */
    var error by mutableStateOf<String?>(null)
    var done by mutableStateOf<String?>(null)

    private val formKeys = IntentKeys()
    private val chargeKeys = IntentKeys()

    suspend fun loadForms() {
        formsError = null
        try {
            forms = deps.client.forms()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deps.onFailure(ModuleIds.FORMS, e)
            formsError = ConversationItemsRules.explain(e)
        }
    }

    fun refreshForms(): Job = viewModelScope.launch { loadForms() }

    /** Envia o formulário como link de uso único (a conversa precisa estar assumida). [onSent] fecha a folha. */
    fun sendForm(form: FormSummary, onSent: () -> Unit = {}): Job? {
        if (busy != null) return null
        val key = formKeys.key("form:$conversationId:${form.id}")
        busy = "form"
        error = null
        return viewModelScope.launch {
            try {
                deps.client.sendForm(conversationId, form.id, key)
                formKeys.settle(null)
                done = "Formulário \"${form.displayName}\" enviado ao cliente"
                onSent()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                formKeys.settle(e)
                deps.onFailure(ModuleIds.FORMS, e)
                error = ConversationItemsRules.explain(e)
            } finally {
                busy = null
            }
        }
    }

    /**
     * Cobra pelo Pix ou link; a cobrança aparece como "Aguardando pagamento" até o provedor confirmar. Valor de R$ 0,01 a
     * R$ 100.000,00 e descrição até 120 caracteres, conferidos antes de ir ao servidor.
     */
    fun charge(method: String, amountText: String, description: String, onSent: () -> Unit = {}): Job? {
        if (busy != null) return null
        val cents = ConversationItemsRules.amount(amountText)
        val text = description.trim()
        when {
            method != "pix" && method != "link" -> { error = "Escolha Pix ou link."; return null }
            cents == null -> { error = "Valor entre R$ 0,01 e R$ 100.000,00. Use, por exemplo, 49,90."; return null }
            !ConversationItemsRules.validDescription(text) -> { error = "Informe a descrição da cobrança (até 120 caracteres)."; return null }
        }
        val amount = cents!!
        val key = chargeKeys.key("charge:$conversationId:$method:$amount:$text")
        busy = "charge"
        error = null
        return viewModelScope.launch {
            try {
                deps.client.charge(conversationId, method, amount, text, key)
                chargeKeys.settle(null)
                done = "Cobrança de ${Money.format(amount)} enviada"
                onSent()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                chargeKeys.settle(e)
                deps.onFailure(ModuleIds.PAYMENTS, e)
                error = ConversationItemsRules.explain(e)
            } finally {
                busy = null
            }
        }
    }

    /** A chave guardada para repetir com segurança (falha de rede). */
    val pendingChargeKey: String? get() = chargeKeys.pendingKey
    val pendingFormKey: String? get() = formKeys.pendingKey
}
