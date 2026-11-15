package br.com.queven.wabotia.device.core

import br.com.queven.wabotia.device.core.Campaign
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.time.Instant

/** Uma campanha pronta para a tela: o texto, ou a imagem já baixada e conferida. */
data class CampaignShown(
    val campaignId: String,
    val text: String?,
    val image: File?,
    /** Quanto tempo fica na tela (`duracao_s`); `null`, o padrão do painel. */
    val durationMillis: Long? = null,
)

/**
 * O cache das campanhas do painel (contrato "Campanhas na central"). Só entra
 * o que vale agora e é do painel; a mídia (`/midia/campanhas/<hex>`) vem da
 * central pela LAN — de [bases], na ordem —, é conferida pelo `sha256` e fica
 * até vencer. Sem rede, o painel segue com o que já baixou; o que não confere
 * não aparece, e sem imagem vale o título.
 */
class CampaignCache(
    private val folder: File,
    private val fetch: (String) -> ByteArray = ::httpGet,
    private val now: () -> Instant = Instant::now,
    /** `http://ip:porta` da central, para a mídia por caminho. */
    private val bases: () -> List<String> = { emptyList() },
) {
    /** As campanhas para mostrar, na ordem do snapshot. Faz E/S: chamar fora da thread principal. */
    @Synchronized
    fun current(campaigns: List<Campaign>): List<CampaignShown> {
        val live = CampaignRules.forPanel(CampaignRules.live(campaigns, now()))
        folder.mkdirs()
        val kept = mutableSetOf<String>()
        val shown =
            live.mapNotNull { campaign ->
                val duration = campaign.duracaoS?.takeIf { it > 0 }?.let { it * 1_000L }
                val title = campaign.titulo?.takeIf { it.isNotBlank() }
                if (!CampaignRules.isMedia(campaign.criativo)) {
                    return@mapNotNull CampaignShown(campaign.campaignId, campaign.criativo, null, duration)
                }
                val sha = CampaignRules.sha256Of(campaign.hash)
                val file = sha?.let { File(folder, it) }
                if (file != null && sha != null) {
                    kept += file.name
                    if (!file.isFile) download(campaign.criativo, sha)?.let(file::writeBytes)
                }
                when {
                    file != null && file.isFile -> CampaignShown(campaign.campaignId, title, file, duration)
                    // Sem a imagem (central fora do ar, hash que não confere), o título ainda vale.
                    title != null -> CampaignShown(campaign.campaignId, title, null, duration)
                    else -> null
                }
            }
        // Vencida ou fora do snapshot: sai do aparelho.
        folder.listFiles()?.filter { it.name !in kept }?.forEach { it.delete() }
        return shown
    }

    /** Baixa e confere; caminho relativo tenta cada endereço da central, na ordem. */
    private fun download(criativo: String, sha: String): ByteArray? {
        val urls = if (criativo.startsWith("/")) bases().map { it.trimEnd('/') + criativo } else listOf(criativo)
        return urls.firstNotNullOfOrNull { url ->
            runCatching { fetch(url) }.getOrNull()?.takeIf { CampaignRules.hex(it) == sha }
        }
    }

    companion object {
        private fun httpGet(url: String): ByteArray {
            val connection = URL(url).openConnection() as HttpURLConnection
            connection.connectTimeout = 10_000
            connection.readTimeout = 20_000
            return try {
                check(connection.responseCode in 200..299) { "HTTP ${connection.responseCode}" }
                connection.inputStream.use { it.readBytes() }
            } finally {
                connection.disconnect()
            }
        }
    }
}

object CampaignRules {
    /** Vigente: `inicio ≤ agora < valido_ate` (sem um deles, aberto). Data ilegível não entra. */
    fun live(campaigns: List<Campaign>, now: Instant): List<Campaign> =
        campaigns.filter { campaign ->
            if (campaign.criativo.isBlank() && campaign.titulo.isNullOrBlank()) return@filter false
            val started = campaign.inicio?.let { runCatching { !Instant.parse(it).isAfter(now) }.getOrDefault(false) } ?: true
            val until = campaign.validade ?: return@filter started
            started && (runCatching { Instant.parse(until) }.getOrNull()?.isAfter(now) ?: false)
        }

    /** Só o que é do painel; sem superfícies declaradas, vale. */
    fun forPanel(campaigns: List<Campaign>): List<Campaign> =
        campaigns.filter { it.superficies.isEmpty() || "painel" in it.superficies }

    /** Mídia: caminho na central (`/midia/...`) ou URL; o resto é texto. */
    fun isMedia(criativo: String): Boolean = criativo.startsWith("/") || isUrl(criativo)

    fun isUrl(criativo: String): Boolean = criativo.startsWith("https://") || criativo.startsWith("http://")

    /** `sha256:<hex>` (ou só o hex) em minúsculas; `null` se não for um sha256. */
    fun sha256Of(hash: String?): String? =
        hash?.removePrefix("sha256:")?.lowercase()?.takeIf { it.length == 64 && it.all { c -> c in '0'..'9' || c in 'a'..'f' } }

    fun hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
