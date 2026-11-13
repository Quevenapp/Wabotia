package br.com.queven.wabotia.core

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri

/** Endereços públicos fixos do Wabotia (não dependem do servidor escolhido pela pessoa). */
object Links {
    /** Política de privacidade do aplicativo (a mesma informada na Play Store). */
    const val PRIVACY_POLICY = "https://wabotia.queven.app/privacidade"

    /** Abre o endereço no navegador. Devolve false quando nenhum aplicativo consegue abri-lo. */
    fun open(context: Context, url: String): Boolean = try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (_: ActivityNotFoundException) {
        false
    }
}
