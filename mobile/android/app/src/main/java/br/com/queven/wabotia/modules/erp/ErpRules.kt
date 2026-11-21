package br.com.queven.wabotia.modules.erp

import br.com.queven.wabotia.modules.Money
import br.com.queven.wabotia.queue.QueueException
import java.io.IOException
import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode

/** As partes do ERP que o aplicativo usa (src/erp/parts.ts): cada uma é um módulo da área. */
object ErpParts {
    const val CUSTOMERS = "erp"
    const val PRODUCTS = "erp-produtos"
    const val SALES = "erp-vendas"
    const val STOCK = "erp-estoque"
    const val FINANCE = "erp-financeiro"

    /** Nome de cada parte em tela (o mesmo da tela Módulos do painel). */
    val NAMES = mapOf(
        CUSTOMERS to "Cadastros",
        PRODUCTS to "Produtos e serviços",
        SALES to "Vendas",
        STOCK to "Estoque",
        FINANCE to "Financeiro",
    )

    fun offMessage(part: String): String =
        "Esta tela faz parte de ${NAMES[part] ?: part}, que está desligado. Um administrador liga em Gestão → Módulos, no painel."
}

/** O papel da pessoa no ERP (`erp:<papel>` em Pessoas e acessos; o administrador do Wabotia vale `admin`). */
enum class ErpRole(val id: String, val label: String) {
    ADMIN("admin", "Administração"),
    CONSULTA("consulta", "Consulta"),
    VENDAS("vendas", "Vendas"),
    FINANCEIRO("financeiro", "Financeiro"),
    ESTOQUE("estoque", "Estoque"),
    FISCAL("fiscal", "Fiscal");

    companion object {
        fun of(id: String?): ErpRole? = entries.firstOrNull { it.id == id }
    }
}

/**
 * O que a entrada "Gestão" mostra: só com o ERP ligado na área e um papel `erp:*` (ou administrador). Cada item respeita a
 * parte dele; os botões de escrita seguem o papel (mesma tabela de src/erp/role-resources.ts), e o servidor decide no fim.
 */
data class ErpAccess(val role: ErpRole, val parts: Set<String>) {
    private fun has(part: String) = part in parts

    val customers: Boolean get() = has(ErpParts.CUSTOMERS)
    val products: Boolean get() = has(ErpParts.PRODUCTS) && role != ErpRole.FINANCEIRO
    val stock: Boolean get() = products && has(ErpParts.STOCK)
    val quickOrder: Boolean get() = has(ErpParts.SALES) && has(ErpParts.PRODUCTS) && role in setOf(ErpRole.ADMIN, ErpRole.VENDAS)
    val bills: Boolean get() = has(ErpParts.FINANCE) && role in setOf(ErpRole.ADMIN, ErpRole.CONSULTA, ErpRole.FINANCEIRO)

    /** Últimos pedidos na ficha do cliente (quem lê pedidos de venda). */
    val customerOrders: Boolean get() = has(ErpParts.SALES) && role in setOf(ErpRole.ADMIN, ErpRole.CONSULTA, ErpRole.VENDAS, ErpRole.FISCAL)
    val customerBills: Boolean get() = bills

    val canCreateCustomer: Boolean get() = customers && role != ErpRole.CONSULTA
    val canAdjustStock: Boolean get() = stock && role in setOf(ErpRole.ADMIN, ErpRole.ESTOQUE)
    val canSettle: Boolean get() = bills && role in setOf(ErpRole.ADMIN, ErpRole.FINANCEIRO)

    val anything: Boolean get() = customers || products || quickOrder || bills

    companion object {
        /**
         * `null` quando a Gestão não aparece: ERP desligado na área ou pessoa sem papel do ERP. [grants] são os papéis da
         * pessoa vindos de `GET /capabilities` (`profiles[].grants`, só de módulos ligados).
         */
        fun of(modules: Set<String>, grants: Set<String>, isAdmin: Boolean): ErpAccess? {
            if (ErpParts.CUSTOMERS !in modules) return null
            val role = if (isAdmin) ErpRole.ADMIN else grants.firstNotNullOfOrNull { g -> if (g.startsWith("erp:")) ErpRole.of(g.removePrefix("erp:")) else null }
            return role?.let { ErpAccess(it, modules.filter { m -> m == "erp" || m.startsWith("erp-") }.toSet()) }?.takeIf { it.anything }
        }
    }
}

/** Quantidades, preços e totais exatos, com as mesmas regras do servidor (packages/erp-domain: centavos, meio para cima). */
object ErpNumbers {
    private val HUNDRED_TRILLION = BigInteger.TEN.pow(14)
    private val MILLION = BigInteger.TEN.pow(6)

    /** "1,5", "2", "0,25" → "1.5" (até 6 casas, maior que zero); `null` quando não serve. */
    fun quantity(text: String): String? {
        val t = text.trim().replace(" ", "").replace(".", "").replace(",", ".")
        if (!Regex("^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,6})?$").matches(t)) return null
        val value = BigDecimal(t)
        if (value.signum() <= 0) return null
        return value.stripTrailingZeros().toPlainString()
    }

    /** Quantidade do servidor ("12.500000", "-3.000000") para a tela: "12,5", "-3". */
    fun showQuantity(value: String?): String {
        val v = value?.trim()?.toBigDecimalOrNull() ?: return "0"
        val plain = v.stripTrailingZeros().toPlainString()
        return if (plain == "-0") "0" else plain.replace(".", ",")
    }

    /** Preço do produto ("10.5000", "0.1234567890") em centavos arredondados, para mostrar. */
    fun priceCents(price: String?): Long? = price?.trim()?.toBigDecimalOrNull()?.movePointRight(2)?.setScale(0, RoundingMode.HALF_UP)?.toLong()

    fun showPrice(price: String?): String = priceCents(price)?.let(Money::format) ?: "Sem preço"

    /** O preço como o servidor aceita no item (até 10 casas). */
    fun unitPrice(price: String?): String? {
        val v = price?.trim()?.toBigDecimalOrNull()?.takeIf { it.signum() >= 0 } ?: return null
        val scaled = if (v.scale() > 10) v.setScale(10, RoundingMode.HALF_UP) else v
        val plain = scaled.stripTrailingZeros().toPlainString()
        return if (plain.contains('.')) plain else "$plain.00"
    }

    /** Valor do item em centavos: quantidade (6 casas) × preço (10 casas), meio para cima. */
    fun lineCents(quantity: String, unitPrice: String): Long {
        val q = BigDecimal(quantity).movePointRight(6).toBigIntegerExact()
        val p = BigDecimal(unitPrice).movePointRight(10).toBigIntegerExact()
        return q.multiply(p).add(HUNDRED_TRILLION.shiftRight(1)).divide(HUNDRED_TRILLION).toLong()
    }

    /** "5,00" (reais) ou "10" (%) → o valor do desconto como o servidor espera ("5.00" ou "10.0000"). */
    fun discountValue(text: String, percent: Boolean): String? {
        val t = text.trim()
        if (t.isEmpty()) return if (percent) "0.0000" else "0.00"
        if (percent) {
            val v = t.replace(",", ".").toBigDecimalOrNull()?.takeIf { it.signum() >= 0 && it <= BigDecimal(100) && it.scale() <= 4 } ?: return null
            return v.setScale(4, RoundingMode.UNNECESSARY).toPlainString()
        }
        val cents = Money.parse(t) ?: return null
        return centsText(cents)
    }

    /** Desconto em centavos sobre o subtotal: valor fixo ou percentual (4 casas, meio para cima). */
    fun discountCents(subtotal: Long, value: String, percent: Boolean): Long {
        if (!percent) return BigDecimal(value).movePointRight(2).toLong()
        val rate = BigDecimal(value).movePointRight(4).toBigIntegerExact()
        return BigInteger.valueOf(subtotal).multiply(rate).add(MILLION.shiftRight(1)).divide(MILLION).toLong()
    }

    /** 1234 → "12.34". */
    fun centsText(cents: Long): String = "${cents / 100}.${(cents % 100).toString().padStart(2, '0')}"
}

/** O total do pedido rápido, igual ao que o servidor calcula (para a parcela única bater). */
data class ErpOrderTotals(val subtotal: Long, val discount: Long, val total: Long) {
    val valid: Boolean get() = discount <= subtotal

    companion object {
        fun of(lines: List<ErpCartLine>, discountValue: String, percent: Boolean): ErpOrderTotals? {
            val subtotal = lines.sumOf { line ->
                val price = ErpNumbers.unitPrice(line.product.price) ?: return null
                ErpNumbers.lineCents(line.quantity, price)
            }
            val discount = ErpNumbers.discountCents(subtotal, discountValue, percent)
            return ErpOrderTotals(subtotal, discount, subtotal - discount)
        }
    }
}

/** Textos da Gestão: situação, telefones e as recusas do ERP em palavras. */
object ErpText {
    const val OFFLINE_READ = "Sem conexão com o Wabotia e nenhuma cópia guardada neste aparelho. Confira a internet e toque em Tentar de novo."
    const val OFFLINE_WRITE = "Sem conexão. Nada foi enviado: tente de novo quando a internet voltar."
    const val CAMERA_DENIED = "Para ler o código de barras, libere a câmera para o Wabotia nas configurações do aparelho."
    const val NO_BARCODE = "Não achei código de barras na foto. Aproxime o código, com boa luz, e tente de novo."

    fun offlineBanner(savedAt: Long): String =
        "Sem conexão. Você está vendo a cópia de ${br.com.queven.wabotia.modules.BrasiliaTime.shortWithTime(savedAt)}. Para mudar alguma coisa, conecte-se."

    val SALE_STATUS = mapOf(
        "draft" to "Em digitação", "open" to "Em aberto", "verified" to "Verificado", "in_progress" to "Em andamento",
        "partially_fulfilled" to "Atendido parcialmente", "fulfilled" to "Atendido", "cancelled" to "Cancelado",
        "agency_sale" to "Venda agenciada", "partially_invoiced" to "Faturado parcialmente", "checkout_partial" to "Checkout parcial",
    )

    fun saleStatus(value: String): String = SALE_STATUS[value] ?: value.replace('_', ' ')

    /** Telefone do cadastro só com dígitos, com 55 na frente quando é número brasileiro sem DDI. */
    fun whatsappDigits(phone: String?): String? {
        val d = phone?.filter(Char::isDigit)?.trimStart('0')?.takeIf { it.length >= 8 } ?: return null
        return if (d.length in 10..11) "55$d" else d
    }

    fun dialUri(phone: String?): String? = phone?.filter { it.isDigit() || it == '+' }?.takeIf { it.count(Char::isDigit) >= 8 }?.let { "tel:$it" }

    fun whatsappUri(phone: String?): String? = whatsappDigits(phone)?.let { "https://wa.me/$it" }

    /** Código de barras lido: 8, 12, 13 ou 14 dígitos (EAN/UPC/GTIN), ou outro texto curto sem controle. */
    fun barcode(value: String?): String? {
        val t = value?.trim()?.takeIf { it.isNotEmpty() && it.length <= 120 && it.none { c -> c.isISOControl() } } ?: return null
        return t
    }

    /** O produto cujo GTIN ou código é exatamente o lido (a busca do servidor também acha parecidos). */
    fun exactBarcode(products: List<ErpProduct>, code: String): ErpProduct? =
        products.firstOrNull { it.gtin?.trim() == code } ?: products.firstOrNull { it.code?.trim() == code }

    /** A recusa do servidor dita para o dono do negócio: o que aconteceu e o que fazer. */
    fun message(error: Throwable, part: String? = null): String {
        if (error is IOException) return OFFLINE_READ
        val e = error as? QueueException ?: return error.message ?: "Algo deu errado. Tente de novo."
        if (e.status == 0) return OFFLINE_READ
        if (e.status == 409 && e.code == "module_disabled") return part?.let(ErpParts::offMessage) ?: "Esta parte da Gestão está desligada. Um administrador liga em Gestão → Módulos, no painel."
        return when (e.code) {
            "ERP_FORBIDDEN", "ERP_ACCESS_DENIED", "ERP_DOCUMENT_PERMISSION_DENIED", "forbidden", "erp_user_required" ->
                "Seu papel no ERP não permite esta ação. Peça ao administrador em Pessoas e acessos."
            "ERP_ACCESS_OUTSIDE_SCHEDULE" -> "Fora do horário liberado para você no ERP. Tente no horário combinado ou fale com o administrador."
            "ERP_MFA_REQUIRED", "mfa_required" -> "Esta ação pede a confirmação em duas etapas. Faça pelo painel, no navegador, com o segundo fator."
            "ERP_CONFLICT", "ERP_DOCUMENT_VERSION_LOCKED" -> "Alguém mudou este registro agora há pouco. A tela foi atualizada: confira e tente de novo."
            "ERP_NOT_FOUND", "not_found" -> "Não achei este registro no ERP. Ele pode ter sido excluído; atualize a lista."
            "ERP_CONTACT_DUPLICATE_DOCUMENT" -> "Já existe um cliente com este CPF/CNPJ. Procure por ele na busca."
            "ERP_CONTACT_REQUIRED_FIELD" -> "O cadastro de clientes desta empresa pede mais dados. Complete pelo painel ou preencha os campos pedidos."
            "ERP_CONTACT_INVALID_FIELD" -> "Algum dado do cliente não confere (CPF/CNPJ, e-mail ou telefone). Revise e tente de novo."
            "ERP_CONTACT_NOT_VISIBLE" -> "Este cliente é de outro vendedor e não aparece para você."
            "ERP_CUSTOMER_RESTRICTED", "erp_customer_restricted" -> "O cadastro deste cliente está restrito pela privacidade. Fale com o administrador."
            "ERP_DOCUMENT_CREDIT_LIMIT" -> "O pedido passa do limite de crédito do cliente. Diminua o valor ou fale com o financeiro."
            "ERP_DOCUMENT_APPROVAL_REQUIRED" -> "O desconto passa do seu limite e precisa de aprovação. Diminua o desconto ou peça a aprovação."
            "ERP_DOCUMENT_LOT_UNAVAILABLE" -> "O produto pede lote e o lote não está disponível. Monte este pedido pelo painel."
            "ERP_DOCUMENT_QUANTITY_DECIMALS" -> "A quantidade tem mais casas decimais do que este produto aceita."
            "ERP_PAYMENT_METHOD_INACTIVE" -> "Esta forma de pagamento foi desativada. Escolha outra."
            "ERP_INVALID_QUERY", "ERP_INVALID_INPUT", "ERP_VALIDATION_FAILED", "invalid_request" ->
                "O ERP não aceitou os dados. Confira quantidade, preço, desconto e datas e tente de novo."
            "ERP_UPSTREAM_UNAVAILABLE", "ERP_REQUEST_TIMEOUT", "erp_parts_unavailable", "erp_parts_stale" ->
                "O ERP não respondeu agora. Espere um pouco e tente de novo."
            "ERP_RESULT_UNCONFIRMED" -> "O ERP não confirmou a gravação. Toque de novo para conferir: não duplica."
            "erp_conversa_blocked" -> e.message ?: "Este envio não sai pelo WhatsApp agora."
            else -> e.message?.takeIf { !it.startsWith("O Wabotia recusou") } ?: when (e.status) {
                401 -> "Sua sessão terminou. Entre de novo."
                403 -> "Seu papel no ERP não permite esta ação. Peça ao administrador em Pessoas e acessos."
                409 -> "O ERP recusou por conflito com outra mudança. Atualize e tente de novo."
                in 500..599 -> "O ERP teve um problema agora. Tente de novo em instantes."
                else -> "O ERP recusou (${e.code}). Confira os dados e tente de novo."
            }
        }
    }

    /** Falha que permite mostrar a cópia guardada (sem conexão ou servidor fora do ar). */
    fun isOffline(error: Throwable): Boolean = error is IOException || (error is QueueException && (error.status == 0 || error.status == 408 || error.status >= 500))
}
