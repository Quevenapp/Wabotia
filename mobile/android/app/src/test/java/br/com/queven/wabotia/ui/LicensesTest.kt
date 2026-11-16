package br.com.queven.wabotia.ui

import br.com.queven.wabotia.ui.settings.OpenSourceNotices
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Toda fonte empacotada tem o OFL.txt da família em `assets/licencas-fontes`, e a tela Licenças mostra cada um. */
class LicensesTest {
    private val main = File("src/main")

    @Test fun cadaArquivoDeLicencaExisteEEOficial() {
        OpenSourceNotices.fonts.forEach { n ->
            val text = File(main, "assets/${n.asset}").readText()
            assertTrue("${n.name}: aviso de copyright", text.startsWith("Copyright"))
            assertTrue("${n.name}: texto da OFL 1.1", text.contains("SIL OPEN FONT LICENSE Version 1.1"))
        }
        assertTrue(File(main, "assets/${OpenSourceNotices.APACHE}").readText().contains("Apache License"))
    }

    @Test fun nenhumaFonteSemLicenca() {
        val families = mapOf(
            "anton" to "Anton", "archivo" to "Archivo", "atkinson" to "Atkinson Hyperlegible",
            "b612" to "B612", "lexend" to "Lexend", "overpass" to "Overpass",
        )
        val listed = OpenSourceNotices.fonts.map { it.name }.toSet()
        File(main, "res/font").listFiles().orEmpty().filter { it.extension in setOf("ttf", "otf") }.forEach { font ->
            val family = families.entries.firstOrNull { font.name.contains(it.key) }?.value
            assertTrue("${font.name} sem família conhecida: acrescente a licença", family != null)
            assertTrue("${font.name}: $family fora da tela Licenças", family in listed)
        }
    }
}
