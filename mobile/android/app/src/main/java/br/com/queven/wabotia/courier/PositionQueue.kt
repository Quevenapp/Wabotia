package br.com.queven.wabotia.courier

/**
 * A fila local das posições (docs/ENTREGA.md): guarda até 2 horas sem sinal, descarta as mais velhas, manda em ordem,
 * as mais antigas primeiro, em lotes de até 200, e apaga o que o servidor confirmou (`last_at`). Repetir um lote é
 * seguro: o servidor ignora o que já tem.
 */
class PositionQueue(
    private val maxAgeMillis: Long = 2 * 60 * 60 * 1000L,
    private val batchSize: Int = 200,
    /** Leituras mais próximas que isto da anterior não entram (o semáforo não vira dez pontos iguais). */
    private val minDistanceMeters: Double = 25.0,
) {
    private val points = ArrayDeque<PositionPoint>()

    val size: Int get() = points.size

    fun add(point: PositionPoint, now: Long = point.t) {
        if (point.lat == 0.0 && point.lng == 0.0) return
        if (point.accuracy != null && point.accuracy > 300f) return
        val last = points.lastOrNull()
        if (last != null) {
            if (point.t <= last.t) return
            if (Geo.distanceMeters(last.lat, last.lng, point.lat, point.lng) < minDistanceMeters) return
        }
        points.addLast(point)
        trim(now)
    }

    /** O próximo lote, sem tirar da fila: só a confirmação ([ack]) apaga. */
    fun batch(now: Long): List<PositionPoint> {
        trim(now)
        return points.take(batchSize)
    }

    /** Apaga os pontos até [lastAt], inclusive. Sem `last_at`, apaga o lote enviado. */
    fun ack(lastAt: Long?, sent: List<PositionPoint>) {
        val limit = lastAt ?: sent.lastOrNull()?.t ?: return
        while (points.isNotEmpty() && points.first().t <= limit) points.removeFirst()
    }

    fun clear() = points.clear()

    private fun trim(now: Long) {
        while (points.isNotEmpty() && now - points.first().t > maxAgeMillis) points.removeFirst()
    }
}

/** Distância e previsão sem rede (a mesma conta do servidor: linha reta × fator das ruas na velocidade média). */
object Geo {
    fun distanceMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val r = 6_371_000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLng = Math.toRadians(lng2 - lng1)
        val a = Math.sin(dLat / 2).let { it * it } +
            Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.sin(dLng / 2).let { it * it }
        return 2 * r * Math.asin(Math.sqrt(a))
    }

    fun etaMinutes(distanceMeters: Double, speedKmh: Double = 25.0, roadFactor: Double = 1.3): Int =
        Math.ceil(distanceMeters * roadFactor / (speedKmh * 1000 / 60)).toInt().coerceAtLeast(1)
}

/** De quanto em quanto tempo ler o GPS e mandar o lote, pelo último ritmo do servidor e pela bateria. */
object CourierPacing {
    fun sampleMillis(pace: CourierPace, battery: Int?): Long = scaled(pace.sampleSeconds, battery)

    fun uploadMillis(pace: CourierPace, near: Boolean, battery: Int?): Long =
        scaled(if (near) pace.nearUploadSeconds else pace.uploadSeconds, battery)

    /** Abaixo de 15 % de bateria, o app dobra os intervalos por conta própria (o servidor aceita qualquer ritmo). */
    private fun scaled(seconds: Int, battery: Int?): Long {
        val base = seconds.coerceIn(5, 600) * 1000L
        return if (battery != null && battery < 15) base * 2 else base
    }
}

/** Textos da tela da entrega, sem Android, para testar. */
object CourierTexts {
    fun eta(delivery: CourierDelivery): String? {
        val minutes = delivery.eta?.minutes ?: return null
        if (delivery.arriving) return "Chegando"
        val distance = delivery.eta.distanceM?.let { if (it >= 1000) " · %.1f km".format(java.util.Locale.forLanguageTag("pt-BR"), it / 1000.0) else " · $it m" }.orEmpty()
        return (if (minutes <= 1) "Chegando" else "Cerca de $minutes min") + distance
    }

    fun sharing(delivery: CourierDelivery) = "Compartilhando sua localização com a loja e o cliente — ${delivery.label}"

    const val ENTRY_HELP = "Para quem entrega: escaneie o QR do pedido que a loja entregou. Sem conta; o acesso termina quando a entrega acaba."

    const val CONSENT =
        "Durante a entrega, o Wabotia compartilha a sua localização com o estabelecimento e com o cliente deste pedido, " +
            "para mostrar a previsão de chegada. O compartilhamento começa quando você toca em Iniciar rota, só acontece " +
            "com o app aberto e para quando a entrega é concluída ou cancelada. A posição é apagada em até 24 horas."

    const val NAME_HELP = "O cliente vê este nome nas mensagens que você manda (\"Carlos - Entregador\"). Fica guardado neste aparelho."

    const val CUSTOMER_CLOSED = "O cliente não falou com a loja nas últimas 24 horas, então mensagens para ele não podem ir pelo WhatsApp. Fale com a loja."
}
