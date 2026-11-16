package br.com.queven.wabotia.modules.mensalidade

import android.content.ClipData
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.MoneyOff
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.Money
import br.com.queven.wabotia.modules.agenda.Field
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.SearchField
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.components.SecureScreenEffect
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SegmentedTabs
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.WbFilterChip
import br.com.queven.wabotia.ui.theme.Wb
import kotlinx.coroutines.launch

/** A cor de cada estado da parcela ou da assinatura (sempre com o texto ao lado: nunca só cor). */
@Composable
internal fun mensalidadeColor(state: String?): Color {
    val c = Wb.colors
    return when (state) {
        "paid", "active", "em_dia" -> c.ok
        "overdue", "em_atraso" -> c.danger
        "open" -> c.brand
        "waived" -> c.ticket
        "paused" -> c.warn
        else -> c.muted
    }
}

/** Mensalidades: o mês (resumo e parcelas), as assinaturas e os inadimplentes. */
@Composable
fun MensalidadeScreen(
    container: AppContainer,
    onBack: () -> Unit,
    openInstallment: (String) -> Unit,
    openSubscription: (String) -> Unit,
    initialMode: MensalidadeViewModel.Mode = MensalidadeViewModel.Mode.MONTH,
) {
    // Pagadores, valores e atrasos: sem captura (Ajustes → Proteger telas com dados de clientes).
    SecureScreenEffect(container)
    val vm: MensalidadeViewModel = viewModel { MensalidadeViewModel(MensalidadeDeps.of(container), container, initialMode) }
    val c = Wb.colors
    LifecycleResumeEffect(Unit) {
        vm.refresh()
        onPauseOrDispose { }
    }
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            DetailTopBar("Mensalidades", onBack, subtitle = "Parcelas, assinaturas e inadimplentes", actions = {
                IconButton(onClick = { vm.refresh() }) { Icon(Icons.Filled.Refresh, contentDescription = "Atualizar", tint = c.textSecondary) }
            })
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            SegmentedTabs(
                MensalidadeViewModel.Mode.entries.map { it to it.label },
                vm.mode,
                { vm.changeMode(it) },
                Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp),
            )
            when {
                vm.loading && vm.summary == null && vm.installments.isEmpty() && vm.subscriptions.isEmpty() && vm.delinquents.isEmpty() ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
                vm.error != null && vm.summary == null && vm.subscriptions.isEmpty() && vm.delinquents.isEmpty() -> ErrorState(vm.error.orEmpty(), onRetry = { vm.refresh() })
                vm.mode == MensalidadeViewModel.Mode.MONTH -> MonthList(vm, openInstallment)
                vm.mode == MensalidadeViewModel.Mode.SUBSCRIPTIONS -> SubscriptionList(vm, openSubscription)
                else -> DelinquentList(vm, openSubscription)
            }
        }
    }
}

@Composable
private fun MonthList(vm: MensalidadeViewModel, open: (String) -> Unit) {
    val c = Wb.colors
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item("month") {
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { vm.shiftMonth(-1) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "Mês anterior", tint = c.textPrimary) }
                Text(BrasiliaTime.month(vm.month), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, color = c.textPrimary, fontWeight = FontWeight.SemiBold)
                if (vm.month != BrasiliaTime.currentMonth()) TextButton(onClick = { vm.goCurrentMonth() }) { Text("Mês atual", color = c.brand) }
                IconButton(onClick = { vm.shiftMonth(1) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "Próximo mês", tint = c.textPrimary) }
            }
        }
        vm.summary?.let { s ->
            item("summary") { SummaryCard(s) }
            if (s.paymentsReady == false) item("payments") {
                InlineNotice(
                    "A Cobrança (Pix e link) não está configurada: as parcelas não são cobradas pelo WhatsApp até um administrador configurar. A baixa manual continua valendo.",
                    Modifier.padding(horizontal = 16.dp, vertical = 6.dp), color = c.warn,
                )
            }
        }
        item("search") { SearchField(vm.query, { vm.search(it) }, "Cliente ou telefone", Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp)) }
        item("filters") {
            LazyRow(contentPadding = PaddingValues(16.dp, 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(MensalidadeRules.FILTERS, key = { it.first }) { (id, title) ->
                    WbFilterChip(title, vm.filter == id, { vm.changeFilter(id) }, count = vm.count(id).takeIf { it > 0 })
                }
            }
        }
        if (vm.installments.isEmpty() && !vm.loading) item("empty") {
            Text(
                if (vm.query.isBlank()) "Nenhuma parcela neste mês com esse filtro." else "Nada encontrado para essa busca.",
                Modifier.padding(horizontal = 20.dp, vertical = 12.dp), color = c.textSecondary,
            )
        }
        items(vm.installments, key = { it.id }) { i -> InstallmentRow(i) { open(i.id) } }
    }
}

@Composable
private fun SummaryCard(s: MensalidadeSummary) {
    val c = Wb.colors
    WbCard(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row {
                Amount("Previsto", s.expectedCents, c.textPrimary, Modifier.weight(1f))
                Amount("Recebido", s.receivedCents, c.ok, Modifier.weight(1f))
            }
            Row {
                Amount("Em aberto", s.openCents, c.brand, Modifier.weight(1f))
                Amount("Vencido", s.overdueCents, c.danger, Modifier.weight(1f))
            }
            HorizontalDivider(color = c.hairline)
            s.receivedInMonth?.let { r ->
                Text("Entrou no mês: ${Money.format(r.cents ?: 0)} em ${countText(r.count ?: 0, "pagamento", "pagamentos")}", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
            }
            s.overdueTotal?.takeIf { (it.count ?: 0) > 0 }?.let { o ->
                Text(
                    "Em atraso no total: ${Money.format(o.cents ?: 0)} em ${countText(o.count ?: 0, "parcela", "parcelas")} de ${countText(o.subscriptions ?: 0, "assinatura", "assinaturas")}",
                    color = c.danger, style = MaterialTheme.typography.bodySmall,
                )
            }
            s.waivedCents?.takeIf { it > 0 }?.let { Text("Isento no mês: ${Money.format(it)}", color = c.textSecondary, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

private fun countText(n: Int, one: String, many: String) = if (n == 1) "1 $one" else "$n $many"

@Composable
private fun Amount(label: String, cents: Long?, color: Color, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(label, color = Wb.colors.textSecondary, style = MaterialTheme.typography.bodySmall)
        Text(Money.format(cents ?: 0), color = color, fontWeight = FontWeight.Bold, fontSize = 17.sp)
    }
}

/**
 * Uma parcela na lista. Nas parcelas dentro da assinatura o servidor não repete cliente e plano: vêm da assinatura
 * ([customerName] e [planName]), como no iOS.
 */
@Composable
private fun InstallmentRow(
    i: Installment,
    customerName: String? = null,
    planName: String? = null,
    modifier: Modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
    onClick: () -> Unit,
) {
    val c = Wb.colors
    WbCard(modifier.testTag("mensalidade.installment"), onClick = onClick) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.width(58.dp)) {
                Text(i.dueDate?.takeLast(5)?.split("-")?.reversed()?.joinToString("/") ?: "—", fontSize = 16.sp, fontWeight = FontWeight.Bold, color = c.textPrimary)
                Text("vence", fontSize = 11.sp, color = c.textSecondary)
            }
            Column(Modifier.weight(1f)) {
                Text(MensalidadeRules.rowTitle(i, customerName), color = c.textPrimary, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val detail = MensalidadeRules.rowDetail(i, planName)
                if (detail.isNotEmpty()) Text(detail, color = c.textSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(Money.format(i.amountCents ?: 0), color = c.textPrimary, fontWeight = FontWeight.SemiBold)
                Pill(i.label, mensalidadeColor(i.state))
            }
        }
    }
}

@Composable
private fun SubscriptionList(vm: MensalidadeViewModel, open: (String) -> Unit) {
    val c = Wb.colors
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item("search") { SearchField(vm.query, { vm.search(it) }, "Cliente, pagador, documento ou telefone", Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp)) }
        item("filters") {
            LazyRow(contentPadding = PaddingValues(16.dp, 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(MensalidadeRules.SUBSCRIPTION_FILTERS, key = { it.first }) { (id, title) ->
                    WbFilterChip(title, vm.subscriptionFilter == id, { vm.changeSubscriptionFilter(id) }, count = vm.subscriptionCount(id).takeIf { it > 0 })
                }
            }
        }
        if (vm.subscriptions.isEmpty() && !vm.loading) item("empty") {
            // O EmptyState rola sozinho: dentro de um item de LazyColumn ele precisa de uma altura limitada, senão o
            // Compose derruba o app ("measured with an infinity maximum height").
            EmptyState(
                Icons.Filled.Payments, "Nenhuma assinatura aqui", Modifier.fillParentMaxHeight(0.6f),
                subtitle = "As assinaturas são criadas no painel, em Gestão → Mensalidades.",
            )
        }
        items(vm.subscriptions, key = { it.id }) { s ->
            WbCard(Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("mensalidade.subscription"), onClick = { open(s.id) }) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(s.customerName, Modifier.weight(1f), color = c.textPrimary, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Pill(s.label, mensalidadeColor(s.state))
                    }
                    val payer = s.payer?.name?.takeIf { it.isNotBlank() && it != s.customer?.name }
                    Text(
                        listOfNotNull(s.planName, s.charge?.let(Money::format), s.dueDay?.let { "dia $it" }).joinToString(" · "),
                        color = c.textSecondary, style = MaterialTheme.typography.bodySmall,
                    )
                    if (payer != null || s.payer?.documentText != null) {
                        Text("Pagador: " + listOfNotNull(payer ?: s.payer?.name, s.payer?.documentText).joinToString(" · "), color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                    }
                    if ((s.overdueCount ?: 0) > 0) {
                        Text("${countText(s.overdueCount ?: 0, "parcela vencida", "parcelas vencidas")} · ${Money.format(s.overdueCents ?: 0)}", color = c.danger, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

@Composable
private fun DelinquentList(vm: MensalidadeViewModel, open: (String) -> Unit) {
    val c = Wb.colors
    if (vm.delinquents.isEmpty()) {
        EmptyState(Icons.Filled.TaskAlt, "Ninguém em atraso", subtitle = "Assinaturas com parcelas vencidas aparecem aqui.")
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 8.dp, bottom = 32.dp)) {
        item("total") {
            Text(
                "${countText(vm.delinquents.size, "assinatura", "assinaturas")} · ${Money.format(vm.delinquents.sumOf { it.overdueCents ?: 0 })} vencidos",
                Modifier.padding(horizontal = 20.dp, vertical = 6.dp), color = c.textSecondary, style = MaterialTheme.typography.bodySmall,
            )
        }
        items(vm.delinquents, key = { it.subscriptionId }) { d ->
            WbCard(Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("mensalidade.delinquent"), onClick = { open(d.subscriptionId) }) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(d.customer?.displayName ?: "Cliente", Modifier.weight(1f), color = c.textPrimary, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(Money.format(d.overdueCents ?: 0), color = c.danger, fontWeight = FontWeight.Bold)
                    }
                    Text(
                        listOfNotNull(d.planName, countText(d.overdueCount ?: 0, "parcela vencida", "parcelas vencidas"), d.oldestDueDate?.let { "desde ${MensalidadeRules.dueText(it)}" }).joinToString(" · "),
                        color = c.textSecondary, style = MaterialTheme.typography.bodySmall,
                    )
                    Text("${countText(d.noticesSent ?: 0, "aviso enviado", "avisos enviados")}" + if (d.subscriptionStatus != null && d.subscriptionStatus != "active") " · assinatura ${MensalidadeRules.subscriptionLabel(d.subscriptionStatus).lowercase()}" else "", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                    // O pagador (nome, documento e telefones autorizados), buscado quando a linha aparece.
                    LaunchedEffect(d.subscriptionId) { vm.loadPayer(d.subscriptionId) }
                    vm.payers[d.subscriptionId]?.let { PayerSummary(it) }
                }
            }
        }
    }
}

/** O pagador na linha do inadimplente: nome e documento, e os telefones autorizados. */
@Composable
private fun PayerSummary(payer: Payer) {
    val c = Wb.colors
    val phones = MensalidadeRules.phones(payer, null).map { it.first }
    Column(Modifier.padding(top = 2.dp).testTag("mensalidade.delinquent.payer")) {
        Text(
            "Pagador: " + listOfNotNull(payer.displayName, payer.documentText).joinToString(" · "),
            color = c.textPrimary, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
        if (phones.isNotEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Phone, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(4.dp))
                Text(phones.joinToString(", "), color = c.textSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** O pagador: nome, CPF ou CNPJ, situação e os telefones autorizados (com o rótulo de quem é cada um). */
@Composable
private fun PayerCard(payer: Payer?, ref: PayerRef?, customer: MensalidadeCustomer?) {
    val c = Wb.colors
    SectionLabel("Pagador", Modifier.padding(start = 0.dp))
    WbCard {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(payer?.displayName ?: ref?.name ?: customer?.displayName ?: "Cliente", Modifier.weight(1f), color = c.textPrimary, fontWeight = FontWeight.SemiBold)
                payer?.situation?.status?.let { Pill(MensalidadeRules.situationLabel(it), mensalidadeColor(it)) }
            }
            (payer?.documentText ?: ref?.documentText)?.let { Text(it, color = c.textSecondary, style = MaterialTheme.typography.bodyMedium) }
            if (payer != null && payer.documentText == null) Text("Sem CPF ou CNPJ cadastrado", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
            val phones = MensalidadeRules.phones(payer, customer)
            if (phones.isNotEmpty()) {
                Text(if (phones.size == 1) "Telefone autorizado" else "Telefones autorizados", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                phones.forEach { (phone, label) ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Phone, contentDescription = null, tint = c.brand, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(phone, color = c.textPrimary)
                        label?.let { Text(" · $it", color = c.textSecondary) }
                    }
                }
            }
            payer?.subscriptions?.takeIf { it.size > 1 }?.let { subs ->
                Text("Paga ${subs.size} assinaturas: " + subs.joinToString(", ") { it.customerName }, color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
            }
            payer?.situation?.graceDays?.takeIf { it > 0 }?.let { Text("Carência de $it dias depois do vencimento.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

/** Uma parcela: cobrança, avisos, baixa e isenção, com o pagador e os telefones dele. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun InstallmentScreen(container: AppContainer, id: String, onBack: () -> Unit, openSubscription: (String) -> Unit, openConversation: (String) -> Unit) {
    // O pagador (nome, CPF ou CNPJ, telefones) e a cobrança: sem captura.
    SecureScreenEffect(container)
    val vm: InstallmentViewModel = viewModel(key = "installment:$id") { InstallmentViewModel(id, MensalidadeDeps.of(container), container) }
    val c = Wb.colors
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboard.current
    var askPay by remember { mutableStateOf(false) }
    var askWaive by remember { mutableStateOf(false) }
    LifecycleResumeEffect(Unit) {
        vm.refresh()
        onPauseOrDispose { }
    }
    LaunchedEffect(vm.done) { vm.done?.let { snackbar.showSnackbar(it); vm.done = null } }
    val i = vm.installment
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = { DetailTopBar("Parcela", onBack, subtitle = i?.let { listOfNotNull(it.customerName, it.periodLabel).joinToString(" · ") }) },
    ) { padding ->
        when {
            i == null && vm.loading -> Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
            i == null -> ErrorState(vm.notice ?: "Parcela não encontrada.", onRetry = { vm.refresh() }, Modifier.padding(padding))
            else -> Column(
                Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                WbCard {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(Money.format(i.amountCents ?: 0), Modifier.weight(1f), fontSize = 28.sp, fontWeight = FontWeight.Black, color = c.textPrimary)
                            Pill(i.label, mensalidadeColor(i.state), filled = true)
                        }
                        Field("Cliente", i.customerName)
                        i.planName?.let { Field("Plano", it) }
                        Field("Competência", i.periodLabel ?: i.periodKey ?: "—")
                        Field("Vencimento", MensalidadeRules.dueText(i.dueDate))
                        if (i.upfront == true) Text("Primeira parcela, cobrada na contratação pelo WhatsApp.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                    }
                }
                vm.notice?.let { InlineNotice(it, onDismiss = { vm.notice = null }) }
                val admin = vm.isAdmin
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (MensalidadeRules.canCharge(i)) {
                        SecondaryButton("Enviar cobrança", { vm.charge() }, loading = vm.busy == "charge", enabled = vm.busy == null, icon = Icons.AutoMirrored.Filled.Send)
                    }
                    if (MensalidadeRules.canPay(i, admin)) {
                        SecondaryButton("Dar baixa", { askPay = true }, loading = vm.busy == "pay", enabled = vm.busy == null, icon = Icons.Filled.TaskAlt, color = c.ok)
                    }
                    if (MensalidadeRules.canWaive(i, admin)) {
                        SecondaryButton("Isentar", { askWaive = true }, loading = vm.busy == "waive", enabled = vm.busy == null, icon = Icons.Filled.MoneyOff, color = c.ticket)
                    }
                }
                if (!admin && i.state in MensalidadeRules.PAYABLE) {
                    Text("Baixa manual e isenção ficam com um administrador da área.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                }
                i.payment?.let { p ->
                    SectionLabel("Cobrança", Modifier.padding(start = 0.dp))
                    WbCard {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Field("Situação", when (p.status) { "paid" -> "Paga"; "created" -> "Aguardando pagamento"; "expired" -> "Venceu"; "cancelled" -> "Cancelada"; "refunded" -> "Devolvida"; else -> p.status ?: "—" })
                            p.chargedAt?.let { Field("Enviada em", BrasiliaTime.shortWithTime(it)) }
                            p.expiresAt?.let { Field("Vale até", BrasiliaTime.shortWithTime(it)) }
                            p.url?.takeIf { it.isNotBlank() }?.let { Field("Link", it) }
                            p.pixCode?.takeIf { it.isNotBlank() }?.let { code ->
                                TextButton(onClick = { clipboard.nativeClipboard.setPrimaryClip(ClipData.newPlainText("Pix", code)); scope.launch { snackbar.showSnackbar("Pix copia e cola copiado") } }) {
                                    Icon(Icons.Filled.ContentCopy, contentDescription = null, tint = c.brand, modifier = Modifier.size(16.dp))
                                    Spacer(Modifier.width(6.dp))
                                    Text("Copiar Pix copia e cola", color = c.brand)
                                }
                            }
                        }
                    }
                }
                i.notices?.let { n ->
                    if ((n.overdue ?: 0) > 0 || !n.error.isNullOrBlank() || n.beforeAt != null) {
                        SectionLabel("Avisos", Modifier.padding(start = 0.dp))
                        WbCard {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                n.beforeAt?.let { Field("Cobrança", BrasiliaTime.shortWithTime(it)) }
                                n.dueAt?.let { Field("No dia", BrasiliaTime.shortWithTime(it)) }
                                if ((n.overdue ?: 0) > 0) Field("Em atraso", countText(n.overdue ?: 0, "aviso", "avisos") + (n.overdueAt?.let { " · último ${BrasiliaTime.short(it)}" } ?: ""))
                                n.error?.takeIf { it.isNotBlank() }?.let { Text(it, color = c.danger, style = MaterialTheme.typography.bodySmall) }
                            }
                        }
                    }
                }
                if (i.state == "paid" || i.state == "waived") {
                    SectionLabel(if (i.state == "paid") "Pagamento" else "Isenção", Modifier.padding(start = 0.dp))
                    WbCard {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            if (i.state == "paid") {
                                i.paidAt?.let { Field("Pago em", BrasiliaTime.short(it)) }
                                Field("Forma", MensalidadeRules.paidVia(i.paidVia))
                            } else {
                                i.waivedAt?.let { Field("Isenta em", BrasiliaTime.short(it)) }
                            }
                            i.paidNote?.takeIf { it.isNotBlank() }?.let { Field("Observação", it) }
                        }
                    }
                }
                PayerCard(vm.payer, vm.subscription?.payer, vm.subscription?.customer ?: i.customer)
                i.subscriptionId?.let { sub ->
                    TextButton(onClick = { openSubscription(sub) }) { Text("Ver assinatura", color = c.brand, fontWeight = FontWeight.SemiBold) }
                }
                vm.subscription?.customer?.conversationId?.let { conversation ->
                    TextButton(onClick = { openConversation(conversation) }) { Text("Abrir conversa", color = c.brand, fontWeight = FontWeight.SemiBold) }
                }
            }
        }
    }
    if (askPay) PayDialog(vm.today, onDismiss = { askPay = false }) { note, day, notify -> askPay = false; vm.pay(note, day, notify) }
    if (askWaive) {
        var note by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { askWaive = false },
            title = { Text("Isentar parcela?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("A parcela não será cobrada (bolsa, cortesia, acordo).", color = c.textSecondary)
                    OutlinedTextField(note, { note = it }, label = { Text("Motivo (opcional)") }, modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = { TextButton(onClick = { askWaive = false; vm.waive(note) }) { Text("Isentar", color = c.ticket) } },
            dismissButton = { TextButton(onClick = { askWaive = false }) { Text("Voltar") } },
        )
    }
}

/** Baixa manual: observação, data do pagamento (até hoje) e se o cliente recebe o comprovante. */
@Composable
private fun PayDialog(today: String, onDismiss: () -> Unit, onConfirm: (note: String, day: String, notify: Boolean) -> Unit) {
    val c = Wb.colors
    var note by remember { mutableStateOf("") }
    var date by remember { mutableStateOf(BrasiliaTime.shortDay(today)) }
    var notify by remember { mutableStateOf(true) }
    val day = MensalidadeRules.paidDate(date, today)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Dar baixa na parcela?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Use quando o cliente pagou fora da cobrança (dinheiro, transferência). Fica registrado quem deu baixa.", color = c.textSecondary)
                OutlinedTextField(
                    date, { date = it }, label = { Text("Data do pagamento") }, singleLine = true, isError = day == null,
                    supportingText = { if (day == null) Text("Use DD/MM/AAAA, até hoje.") }, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(note, { note = it }, label = { Text("Observação (opcional)") }, modifier = Modifier.fillMaxWidth())
                Row(Modifier.fillMaxWidth().clickable { notify = !notify }, verticalAlignment = Alignment.CenterVertically) {
                    Text("Enviar o comprovante ao cliente", Modifier.weight(1f), color = c.textPrimary)
                    Switch(notify, { notify = it }, colors = SwitchDefaults.colors(checkedTrackColor = c.brand))
                }
            }
        },
        confirmButton = { TextButton(onClick = { day?.let { onConfirm(note, it, notify) } }, enabled = day != null) { Text("Dar baixa", color = if (day != null) c.ok else c.muted) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Voltar") } },
    )
}

/** Uma assinatura: o pagador, as parcelas e pausar, retomar ou encerrar. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SubscriptionScreen(container: AppContainer, id: String, onBack: () -> Unit, openInstallment: (String) -> Unit, openConversation: (String) -> Unit) {
    // O pagador (nome, CPF ou CNPJ, telefones) e as parcelas: sem captura.
    SecureScreenEffect(container)
    val vm: SubscriptionViewModel = viewModel(key = "subscription:$id") { SubscriptionViewModel(id, MensalidadeDeps.of(container), container) }
    val c = Wb.colors
    val snackbar = remember { SnackbarHostState() }
    var confirm by remember { mutableStateOf<String?>(null) }
    LifecycleResumeEffect(Unit) {
        vm.refresh()
        onPauseOrDispose { }
    }
    LaunchedEffect(vm.done) { vm.done?.let { snackbar.showSnackbar(it); vm.done = null } }
    val s = vm.subscription
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = { DetailTopBar("Assinatura", onBack, subtitle = s?.let { listOfNotNull(it.customerName, it.planName).joinToString(" · ") }) },
    ) { padding ->
        when {
            s == null && vm.loading -> Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brand) }
            s == null -> ErrorState(vm.notice ?: "Assinatura não encontrada.", onRetry = { vm.refresh() }, Modifier.padding(padding))
            else -> Column(
                Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                WbCard {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(s.customerName, Modifier.weight(1f), fontSize = 20.sp, fontWeight = FontWeight.Bold, color = c.textPrimary)
                            Pill(s.label, mensalidadeColor(s.state), filled = true)
                        }
                        Field("Plano", listOfNotNull(s.planName, s.periodLabel).joinToString(" · ").ifEmpty { "—" })
                        Field("Parcela", s.charge?.let(Money::format) ?: "—")
                        s.discountCents?.takeIf { it > 0 }?.let { Field("Desconto", Money.format(it)) }
                        s.dueDay?.let { Field("Vencimento", "Dia $it") }
                        s.startDate?.let { Field("Início", MensalidadeRules.dueText(it)) }
                        s.endDate?.let { Field("Fim", MensalidadeRules.dueText(it)) }
                        if ((s.overdueCount ?: 0) > 0) Field("Vencidas", "${s.overdueCount} · ${Money.format(s.overdueCents ?: 0)}")
                        s.notes?.takeIf { it.isNotBlank() }?.let { Field("Observação", it) }
                    }
                }
                vm.notice?.let { InlineNotice(it, onDismiss = { vm.notice = null }) }
                val admin = vm.isAdmin
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (MensalidadeRules.canPause(s, admin)) SecondaryButton("Pausar", { confirm = "pause" }, loading = vm.busy == "pause", enabled = vm.busy == null, icon = Icons.Filled.Pause, color = c.warn)
                    if (MensalidadeRules.canResume(s, admin)) SecondaryButton("Retomar", { vm.act("resume") }, loading = vm.busy == "resume", enabled = vm.busy == null, icon = Icons.Filled.PlayArrow, color = c.ok)
                    if (MensalidadeRules.canEnd(s, admin)) SecondaryButton("Encerrar", { confirm = "end" }, loading = vm.busy == "end", enabled = vm.busy == null, icon = Icons.Filled.Block, color = c.danger)
                }
                if (!admin && s.state != "ended") {
                    Text("Pausar, retomar e encerrar ficam com um administrador da área.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                }
                PayerCard(vm.payer, s.payer, s.customer)
                s.customer?.conversationId?.let { conversation ->
                    TextButton(onClick = { openConversation(conversation) }) { Text("Abrir conversa", color = c.brand, fontWeight = FontWeight.SemiBold) }
                }
                val list = s.installments.orEmpty()
                SectionLabel("Parcelas · ${list.size}", Modifier.padding(start = 0.dp))
                if (list.isEmpty()) Text("Nenhuma parcela gerada ainda.", color = c.textSecondary)
                list.forEach { i -> InstallmentRow(i, customerName = s.customer?.displayName, planName = s.planName, modifier = Modifier) { openInstallment(i.id) } }
            }
        }
    }
    confirm?.let { action ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text(if (action == "pause") "Pausar assinatura?" else "Encerrar assinatura?") },
            text = {
                Text(
                    (if (action == "pause") "Retomar volta a gerar parcelas a partir de hoje, sem cobrar os meses da pausa. " else "A assinatura não gera mais parcelas. ") +
                        "As parcelas em aberto que ainda não venceram são canceladas; as vencidas continuam devidas.",
                    color = c.textSecondary,
                )
            },
            confirmButton = {
                TextButton(onClick = { confirm = null; vm.act(action) }) { Text(if (action == "pause") "Pausar" else "Encerrar", color = if (action == "pause") c.warn else c.danger) }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Voltar") } },
        )
    }
}
