package br.com.queven.wabotia.printing

import br.com.thermalprinterkit.ThermalPrintDelivery
import br.com.thermalprinterkit.ThermalPrintResult

/** O que o totem diz do cupom da senha que acabou de mandar (porta do Senhapp). */
sealed interface TicketPrint {
    data object Printing : TicketPrint

    data object Printed : TicketPrint

    /**
     * Não saiu, ou talvez tenha saído: quando a impressora aceitou os bytes e não confirmou (`INDETERMINATE`), a
     * segunda via pede confirmação humana, para não saírem dois papéis com a mesma senha.
     */
    data class Failed(val message: String, val reprintNeedsConfirmation: Boolean) : TicketPrint

    /** Nenhuma impressora escolhida neste aparelho: a senha fica só na tela. */
    data object NoPrinter : TicketPrint

    companion object {
        fun of(result: ThermalPrintResult): TicketPrint =
            when (result) {
                ThermalPrintResult.Printed -> Printed
                is ThermalPrintResult.Failed -> Failed(result.message, result.delivery == ThermalPrintDelivery.INDETERMINATE)
            }
    }
}
