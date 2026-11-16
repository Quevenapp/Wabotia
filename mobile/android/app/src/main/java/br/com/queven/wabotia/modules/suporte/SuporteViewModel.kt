package br.com.queven.wabotia.modules.suporte

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.core.ModuleIds
import br.com.queven.wabotia.modules.IntentKeys
import br.com.queven.wabotia.modules.ModuleFailure
import br.com.queven.wabotia.modules.ProfileApi
import br.com.queven.wabotia.modules.moduleDisabled
import br.com.queven.wabotia.modules.observeModuleEvents
import br.com.queven.wabotia.queue.QueueException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** As dependências do Suporte pago na conversa (trocáveis nos testes). */
class SuporteDeps(
    val client: SuporteClient,
    val onFailure: (Throwable) -> Unit,
    /** Módulo `suporte` ligado na área (capacidades). */
    val enabled: () -> Boolean,
) {
    companion object {
        fun of(container: AppContainer) = SuporteDeps(
            SuporteClient(ProfileApi.current(container)),
            { ModuleFailure.handle(container, ModuleIds.SUPORTE, it) },
            { container.modules.has(ModuleIds.SUPORTE) },
        )
    }
}

/**
 * O Suporte pago numa conversa: a situação (liberado, pagamento pendente, aguardando a equipe) e as ações do
 * atendente (vincular o telefone ao pagador, confirmar e liberar, liberar como cortesia). Os eventos `suporte.*`
 * relêem; só com o módulo ligado, e nunca em grupos. Um 409 `module_disabled` esconde tudo.
 */
class SuporteViewModel(val conversationId: String, private val deps: SuporteDeps, container: AppContainer? = null) : ViewModel() {
    var status by mutableStateOf<SuporteStatus?>(null)
        private set
    var busy by mutableStateOf<String?>(null)
        private set
    var notice by mutableStateOf<String?>(null)
    var done by mutableStateOf<String?>(null)

    private val keys = IntentKeys()

    init {
        container?.let { observeModuleEvents(it, "suporte.") { load() } }
    }

    fun refresh(): Job = viewModelScope.launch { load() }

    suspend fun load() {
        if (!deps.enabled()) {
            status = null
            return
        }
        try {
            status = deps.client.status(conversationId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            deps.onFailure(e)
            val q = e as? QueueException
            if (q != null && (q.moduleDisabled || q.status == 404 || q.status == 403)) status = null
        }
    }

    fun link(): Job? = run("link") { key -> status = deps.client.linkPhone(conversationId, key) }

    fun confirm(): Job? = run("confirm") { key -> deps.client.confirm(conversationId, link = true, key = key) }

    /** Cortesia com motivo (obrigatório, até 300) e validade: até o protocolo fechar (`hours` nulo) ou por horas. */
    fun courtesy(reason: String, hours: Int?): Job? {
        val text = reason.trim()
        if (text.isEmpty()) {
            notice = "Informe o motivo da cortesia."
            return null
        }
        return run("courtesy:$text:${hours ?: 0}") { key -> deps.client.courtesy(conversationId, text.take(300), hours, key) }
    }

    private fun run(action: String, block: suspend (String) -> Unit): Job? {
        if (busy != null) return null
        val name = action.substringBefore(':')
        val key = keys.key("$action:$conversationId")
        busy = name
        notice = null
        return viewModelScope.launch {
            try {
                block(key)
                keys.settle(null)
                done = SuporteRules.success(name)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                keys.settle(e)
                deps.onFailure(e)
                notice = SuporteRules.explain(e) + if ((e as? QueueException)?.retryable == true) ModuleFailure.RETRY_HINT else ""
            } finally {
                busy = null
            }
            load()
        }
    }

    val pendingKey: String? get() = keys.pendingKey
}
