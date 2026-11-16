package br.com.queven.wabotia.ui

import br.com.queven.wabotia.ui.components.SecureCounter
import br.com.queven.wabotia.ui.components.SecureScreenRules
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A proteção contra captura acompanha a tela à vista, não o tempo em que ela fica na composição. */
class SecureScreenTest {
    @Test fun protegeSoATelaAVista() {
        assertTrue(SecureScreenRules.shouldProtect(enabled = true, screenVisible = true, appVisible = true))
        // Coberta por outra tela (link que empilha o Pedido sobre a aba Conversas): solta.
        assertFalse(SecureScreenRules.shouldProtect(enabled = true, screenVisible = false, appVisible = true))
        // O app inteiro foi para segundo plano: mantém, para a miniatura dos Recentes sair em branco.
        assertTrue(SecureScreenRules.shouldProtect(enabled = true, screenVisible = false, appVisible = false))
        assertFalse(SecureScreenRules.shouldProtect(enabled = false, screenVisible = true, appVisible = true))
    }

    @Test fun linkQueEmpilhaOutraTelaTiraAProtecao() {
        var flag = false
        val counter = SecureCounter<String>(on = { flag = true }, off = { flag = false })
        val window = "janela"
        // A aba Conversas aparece e protege; o destino do link entra por cima no mesmo quadro.
        counter.acquire(window)
        assertTrue(flag)
        // A aba Conversas sai de vista (o ciclo de vida do destino cai para CREATED) e solta; o Pedido não protege.
        counter.release(window)
        assertFalse(flag)
        assertEquals(0, counter.count(window))
    }

    @Test fun trocaEntreTelasProtegidasNaoAbreBuraco() {
        var changes = 0
        var flag = false
        val counter = SecureCounter<String>(on = { flag = true; changes++ }, off = { flag = false; changes++ })
        counter.acquire("w") // conversa
        counter.acquire("w") // dados da conversa entram antes de a conversa sair
        counter.release("w") // a conversa sai
        assertTrue(flag)
        counter.release("w")
        assertFalse(flag)
        // Liberar de novo (ou sem ter protegido) não mexe na janela.
        counter.release("w")
        assertEquals(2, changes)
    }
}
