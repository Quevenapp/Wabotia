package br.com.queven.wabotia.core.push

import org.junit.Assert.assertEquals
import org.junit.Test

/** O texto da tela bloqueada diz só o tipo do aviso. */
class NotificationsTest {
    @Test
    fun `versao publica tem texto neutro por tipo`() {
        assertEquals("Nova mensagem", Notifications.publicText("message"))
        assertEquals("Nova mensagem", Notifications.publicText("desconhecido"))
        assertEquals("Novo atendimento na fila", Notifications.publicText("queue"))
        assertEquals("Ligação pelo WhatsApp", Notifications.publicText("call"))
        assertEquals("Protocolo atualizado", Notifications.publicText("ticket"))
    }
}
