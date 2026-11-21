package br.com.queven.wabotia.modules.erp

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material.icons.filled.Storefront
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import br.com.queven.wabotia.core.AdminRole
import br.com.queven.wabotia.core.AppContainer
import br.com.queven.wabotia.modules.BrasiliaTime
import br.com.queven.wabotia.modules.Money
import br.com.queven.wabotia.modules.agenda.Field
import br.com.queven.wabotia.ui.components.DetailTopBar
import br.com.queven.wabotia.ui.components.EmptyState
import br.com.queven.wabotia.ui.components.ErrorState
import br.com.queven.wabotia.ui.components.InlineNotice
import br.com.queven.wabotia.ui.components.Pill
import br.com.queven.wabotia.ui.components.PrimaryButton
import br.com.queven.wabotia.ui.components.RowDivider
import br.com.queven.wabotia.ui.components.SearchField
import br.com.queven.wabotia.ui.components.SecondaryButton
import br.com.queven.wabotia.ui.components.SectionLabel
import br.com.queven.wabotia.ui.components.SettingsRow
import br.com.queven.wabotia.ui.components.WbBottomSheet
import br.com.queven.wabotia.ui.components.WbCard
import br.com.queven.wabotia.ui.components.WbFilterChip
import br.com.queven.wabotia.ui.theme.Wb

/** Rotas da Gestão (ERP). Só têm entrada com o ERP ligado na área e um papel `erp:*` ([ErpAccess]). */
object ErpRoutes {
    const val HOME = "erp"
    const val CUSTOMERS = "erp/customers"
    const val NEW_CUSTOMER = "erp/customers/new"
    const val CUSTOMER = "erp/customer/{id}"
    const val PRODUCTS = "erp/products"
    const val PRODUCT = "erp/product/{id}"
    const val ORDER = "erp/order"
    const val BILLS = "erp/bills"

    fun customer(id: String) = "erp/customer/${Uri.encode(id)}"

    fun product(id: String) = "erp/product/${Uri.encode(id)}"
}

/** O acesso da pessoa à Gestão nesta área, atualizado com as capacidades (módulos e papéis). */
@Composable
fun rememberErpAccess(container: AppContainer): ErpAccess? {
    val enabled by container.modules.enabled.collectAsState()
    val grants by container.modules.grants.collectAsState()
    val roles by container.modules.roles.collectAsState()
    val profile = container.session.profileId
    // Administrador pelo papel atual do servidor (capacidades), não só pelo gravado no login.
    val admin = AdminRole.isAdmin(roles[profile], container.session.user?.role)
    return ErpAccess.of(enabled[profile].orEmpty(), grants[profile].orEmpty(), admin)
}

/** Administrador agora (papel atual do servidor; sem ele, o do login), atualizado com as capacidades. */
@Composable
fun rememberIsAdmin(container: AppContainer): Boolean {
    val roles by container.modules.roles.collectAsState()
    return AdminRole.isAdmin(roles[container.session.profileId], container.session.user?.role)
}

/** As telas da Gestão no grafo do app logado. */
fun NavGraphBuilder.erpScreens(container: AppContainer, nav: NavHostController) {
    composable(ErpRoutes.HOME) { ErpHomeScreen(container, onBack = { nav.popBackStack() }, open = { nav.navigate(it) }) }
    composable(ErpRoutes.CUSTOMERS) {
        ErpCustomersScreen(container, onBack = { nav.popBackStack() }, openCustomer = { nav.navigate(ErpRoutes.customer(it)) }, newCustomer = { nav.navigate(ErpRoutes.NEW_CUSTOMER) })
    }
    composable(ErpRoutes.NEW_CUSTOMER) {
        ErpNewCustomerScreen(container, onBack = { nav.popBackStack() }, onCreated = { id -> nav.popBackStack(); nav.navigate(ErpRoutes.customer(id)) })
    }
    composable(ErpRoutes.CUSTOMER, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
        val id = entry.arguments?.getString("id")?.let(Uri::decode) ?: return@composable
        ErpCustomerScreen(container, id, onBack = { nav.popBackStack() })
    }
    composable(ErpRoutes.PRODUCTS) { ErpProductsScreen(container, onBack = { nav.popBackStack() }, openProduct = { nav.navigate(ErpRoutes.product(it)) }) }
    composable(ErpRoutes.PRODUCT, arguments = listOf(navArgument("id") { type = NavType.StringType })) { entry ->
        val id = entry.arguments?.getString("id")?.let(Uri::decode) ?: return@composable
        ErpProductScreen(container, id, onBack = { nav.popBackStack() })
    }
    composable(ErpRoutes.ORDER) { ErpQuickOrderScreen(container, onBack = { nav.popBackStack() }) }
    composable(ErpRoutes.BILLS) { ErpBillsScreen(container, onBack = { nav.popBackStack() }) }
}

/** Parte desligada (ou papel sem acesso) depois de entrar: a tela diz o que ligar, sem tentar carregar. */
@Composable
private fun PartOff(title: String, part: String, onBack: () -> Unit, roleNote: Boolean = false) {
    Scaffold(containerColor = Wb.colors.background, contentWindowInsets = WindowInsets(0, 0, 0, 0), topBar = { DetailTopBar(title, onBack) }) { padding ->
        EmptyState(
            Icons.Filled.Storefront,
            if (roleNote) "Fora do seu papel no ERP" else "${ErpParts.NAMES[part] ?: part} desligado",
            Modifier.padding(padding),
            subtitle = if (roleNote) "Seu papel no ERP não inclui esta tela. Peça ao administrador em Pessoas e acessos." else ErpParts.offMessage(part),
        )
    }
}

@Composable
private fun Loading(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Wb.colors.brand) }
}

@Composable
private fun OfflineBanner(at: Long?) {
    at?.let { InlineNotice(ErpText.offlineBanner(it), Modifier.padding(horizontal = 16.dp, vertical = 4.dp), color = Wb.colors.warn) }
}

// ---------------------------------------------------------------------------------------------------------------
// Entrada "Gestão"
// ---------------------------------------------------------------------------------------------------------------

private data class HomeRow(val icon: androidx.compose.ui.graphics.vector.ImageVector, val title: String, val subtitle: String, val route: String)

@Composable
fun ErpHomeScreen(container: AppContainer, onBack: () -> Unit, open: (String) -> Unit) {
    val access = rememberErpAccess(container)
    val c = Wb.colors
    LaunchedEffect(Unit) { container.modules.refresh(force = true) }
    Scaffold(containerColor = c.background, contentWindowInsets = WindowInsets(0, 0, 0, 0), topBar = { DetailTopBar("Gestão", onBack, subtitle = access?.let { "Seu papel: ${it.role.label}" }) }) { padding ->
        if (access == null) {
            EmptyState(
                Icons.Filled.Storefront, "Gestão indisponível", Modifier.padding(padding),
                subtitle = "A Gestão aparece com o ERP ligado nesta área e um papel do ERP na sua conta. Um administrador liga em Gestão → Módulos e dá o papel em Pessoas e acessos.",
            )
            return@Scaffold
        }
        LazyColumn(Modifier.padding(padding).fillMaxSize(), contentPadding = PaddingValues(vertical = 12.dp)) {
            item("items") {
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    val rows = buildList {
                        if (access.customers) add(HomeRow(Icons.Filled.People, "Clientes", "Busca, ficha, ligar e WhatsApp" + (if (access.canCreateCustomer) "; cadastro rápido" else ""), ErpRoutes.CUSTOMERS))
                        if (access.products) add(HomeRow(Icons.Filled.Inventory2, "Produtos e estoque", "Busca por nome, código ou código de barras" + (if (access.stock) "; saldo por depósito" else ""), ErpRoutes.PRODUCTS))
                        if (access.quickOrder) add(HomeRow(Icons.Filled.ShoppingCart, "Pedido rápido", "Cliente, itens, desconto e pagamento", ErpRoutes.ORDER))
                        if (access.bills) add(HomeRow(Icons.Filled.AccountBalanceWallet, "Contas", "A receber e a pagar do dia e vencidas", ErpRoutes.BILLS))
                    }
                    rows.forEachIndexed { index, row ->
                        if (index > 0) RowDivider()
                        SettingsRow(row.icon, row.title, subtitle = row.subtitle, onClick = { open(row.route) }, modifier = Modifier.testTag("erp.home.${row.route}"))
                    }
                }
            }
            item("note") {
                Text(
                    "Notas fiscais, compras, relatórios e configurações ficam no painel, no navegador.",
                    color = c.textSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp),
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------------------------------------------------

@Composable
fun ErpCustomersScreen(container: AppContainer, onBack: () -> Unit, openCustomer: (String) -> Unit, newCustomer: () -> Unit) {
    val access = rememberErpAccess(container)
    if (access == null || !access.customers) return PartOff("Clientes", ErpParts.CUSTOMERS, onBack)
    val vm: ErpCustomersViewModel = viewModel { ErpCustomersViewModel(ErpDeps.of(container)) }
    val c = Wb.colors
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { DetailTopBar("Clientes", onBack, actions = { IconButton(onClick = { vm.refresh() }) { Icon(Icons.Filled.Refresh, contentDescription = "Atualizar", tint = c.textSecondary) } }) },
        floatingActionButton = {
            if (access.canCreateCustomer && vm.offlineAt == null) ExtendedFloatingActionButton(
                onClick = newCustomer, containerColor = c.brand, contentColor = c.onBrand, modifier = Modifier.navigationBarsPadding().testTag("erp.customers.new"),
                icon = { Icon(Icons.Filled.PersonAdd, contentDescription = null) }, text = { Text("Novo cliente") },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            SearchField(vm.query, vm::search, "Nome, CPF/CNPJ, telefone ou código", Modifier.padding(16.dp, 10.dp))
            OfflineBanner(vm.offlineAt)
            when {
                vm.loading && vm.items.isEmpty() -> Loading()
                vm.error != null && vm.items.isEmpty() -> ErrorState(vm.error.orEmpty(), onRetry = { vm.refresh() })
                vm.items.isEmpty() -> EmptyState(Icons.Filled.People, "Nenhum cliente encontrado", subtitle = if (vm.query.isBlank()) "Cadastre o primeiro em \"Novo cliente\"." else "Confira o que foi digitado.")
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
                    items(vm.items, key = { it.id }) { item ->
                        WbCard(Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("erp.customer.row"), onClick = { openCustomer(item.id) }) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(item.name, fontWeight = FontWeight.SemiBold, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                item.tradeName.clean()?.let { Text(it, color = c.textSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 1) }
                                Text(item.subtitle.ifBlank { item.mobile.clean() ?: item.phone.clean() ?: "Sem dados de contato" }, color = c.textSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                    if (vm.items.size < vm.total && vm.offlineAt == null) item("more") {
                        LaunchedEffect(vm.items.size) { vm.loadMore() }
                        Loading(Modifier.height(64.dp))
                    }
                }
            }
        }
    }
}

@Composable
fun ErpCustomerScreen(container: AppContainer, id: String, onBack: () -> Unit) {
    val access = rememberErpAccess(container)
    if (access == null || !access.customers) return PartOff("Cliente", ErpParts.CUSTOMERS, onBack)
    val vm: ErpCustomerViewModel = viewModel(key = "erp-customer-$id") { ErpCustomerViewModel(ErpDeps.of(container), id, access) }
    val c = Wb.colors
    val context = LocalContext.current
    val record = vm.record
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { DetailTopBar(record?.name ?: "Cliente", onBack, subtitle = record?.code.clean()?.let { "Cód. $it" }, actions = { IconButton(onClick = { vm.refresh() }) { Icon(Icons.Filled.Refresh, contentDescription = "Atualizar", tint = c.textSecondary) } }) },
    ) { padding ->
        when {
            record == null && vm.loading -> Loading(Modifier.padding(padding))
            record == null -> ErrorState(vm.error ?: "Cliente não encontrado.", onRetry = { vm.refresh() }, Modifier.padding(padding))
            else -> Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
                OfflineBanner(vm.offlineAt)
                val phone = record.bestPhone
                val dial = ErpText.dialUri(phone)
                val whatsapp = ErpText.whatsappUri(phone)
                if (dial != null || whatsapp != null) Row(Modifier.padding(16.dp, 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (dial != null) SecondaryButton("Ligar", { runCatching { context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse(dial))) } }, Modifier.weight(1f), icon = Icons.Filled.Phone)
                    if (whatsapp != null) PrimaryButton("WhatsApp", { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(whatsapp))) } }, Modifier.weight(1f), icon = Icons.Filled.Chat)
                }
                SectionLabel("Dados")
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        record.tradeName.clean()?.let { Field("Nome fantasia", it) }
                        record.document.clean()?.let { Field(if (record.personType == "J") "CNPJ" else if (record.personType == "F") "CPF" else "Documento", it) }
                        Field("Situação", when (record.situation) { "A" -> "Ativo"; "I" -> "Inativo"; "S" -> "Sem movimento"; "E" -> "Excluído"; else -> "—" })
                    }
                }
                SectionLabel("Contato")
                WbCard(Modifier.padding(horizontal = 16.dp)) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Field("Celular", record.mobile.clean() ?: "—")
                        Field("Telefone", record.phone.clean() ?: "—")
                        Field("E-mail", record.email.clean() ?: "—")
                        Field("Endereço", record.addressText ?: "—")
                    }
                }
                if (access.customerOrders) {
                    SectionLabel("Últimos pedidos")
                    WbCard(Modifier.padding(horizontal = 16.dp)) {
                        val orders = vm.orders
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            when {
                                vm.ordersNote != null -> Text(vm.ordersNote.orEmpty(), color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                                orders == null -> Text("Carregando…", color = c.textSecondary)
                                orders.isEmpty() -> Text("Nenhum pedido de venda ainda.", color = c.textSecondary)
                                else -> orders.forEach { o ->
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Column(Modifier.weight(1f)) {
                                            Text("Pedido ${o.number}", color = c.textPrimary, fontWeight = FontWeight.Medium)
                                            Text(listOfNotNull(o.date?.let(BrasiliaTime::shortDay), ErpText.saleStatus(o.status)).joinToString(" · "), color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                                        }
                                        Text(Money.format(ErpNumbers.priceCents(o.total) ?: 0L), color = c.textPrimary)
                                    }
                                }
                            }
                        }
                    }
                }
                if (access.customerBills) {
                    SectionLabel("Contas em aberto")
                    WbCard(Modifier.padding(horizontal = 16.dp)) {
                        val bills = vm.bills
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            when {
                                vm.billsNote != null -> Text(vm.billsNote.orEmpty(), color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                                bills == null -> Text("Carregando…", color = c.textSecondary)
                                bills.isEmpty() -> Text("Nada em aberto.", color = c.textSecondary)
                                else -> bills.forEach { t -> TitleLine(t) }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TitleLine(t: ErpTitle) {
    val c = Wb.colors
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(t.description.ifBlank { t.contactName }, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull("Vence ${BrasiliaTime.shortDay(t.dueOn)}", t.installmentText).joinToString(" · "), color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(Money.format(t.balance), color = c.textPrimary, fontWeight = FontWeight.SemiBold)
            if (t.overdue) Pill("Vencida", c.danger)
        }
    }
}

@Composable
fun ErpNewCustomerScreen(container: AppContainer, onBack: () -> Unit, onCreated: (String) -> Unit) {
    val access = rememberErpAccess(container)
    if (access?.canCreateCustomer != true) return PartOff("Novo cliente", ErpParts.CUSTOMERS, onBack, roleNote = access?.customers == true)
    val vm: ErpNewCustomerViewModel = viewModel { ErpNewCustomerViewModel(ErpDeps.of(container)) }
    val c = Wb.colors
    LaunchedEffect(vm.created) { vm.created?.let { onCreated(it.id) } }
    Scaffold(containerColor = c.background, contentWindowInsets = WindowInsets(0, 0, 0, 0), topBar = { DetailTopBar("Novo cliente", onBack) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(vm.name, { vm.name = it }, label = { Text("Nome *") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("erp.customer.name"))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                WbFilterChip("Pessoa física", vm.personType == "F", { vm.personType = "F" })
                WbFilterChip("Empresa (CNPJ)", vm.personType == "J", { vm.personType = "J" })
            }
            OutlinedTextField(vm.document, { vm.document = it }, label = { Text(if (vm.personType == "J") "CNPJ" else "CPF") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = if (vm.personType == "J") KeyboardType.Text else KeyboardType.Number), modifier = Modifier.fillMaxWidth())
            OutlinedTextField(vm.mobile, { vm.mobile = it }, label = { Text("Celular com DDD") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), modifier = Modifier.fillMaxWidth())
            OutlinedTextField(vm.email, { vm.email = it }, label = { Text("E-mail") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth())
            Text("Endereço e os outros dados você completa no painel, quando precisar.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
            vm.error?.let { InlineNotice(it, onDismiss = { vm.error = null }) }
            PrimaryButton("Cadastrar cliente", { vm.save() }, loading = vm.saving, modifier = Modifier.testTag("erp.customer.save"))
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Produtos e estoque
// ---------------------------------------------------------------------------------------------------------------

@Composable
fun ErpProductsScreen(container: AppContainer, onBack: () -> Unit, openProduct: (String) -> Unit) {
    val access = rememberErpAccess(container)
    if (access?.products != true) return PartOff("Produtos e estoque", ErpParts.PRODUCTS, onBack, roleNote = access != null && ErpParts.PRODUCTS in access.parts)
    val vm: ErpProductsViewModel = viewModel { ErpProductsViewModel(ErpDeps.of(container)) }
    val c = Wb.colors
    val snackbar = remember { SnackbarHostState() }
    val scan = rememberBarcodeScan(onResult = { vm.scan(it) }, onDenied = { vm.notice = ErpText.CAMERA_DENIED })
    LaunchedEffect(vm.scanned) { vm.scanned?.let { vm.scanned = null; openProduct(it.id) } }
    LaunchedEffect(vm.notice) { vm.notice?.let { snackbar.showSnackbar(it); vm.notice = null } }
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            DetailTopBar("Produtos e estoque", onBack, actions = {
                IconButton(onClick = scan, modifier = Modifier.testTag("erp.products.scan")) { Icon(Icons.Filled.QrCodeScanner, contentDescription = "Ler código de barras", tint = c.brand) }
                IconButton(onClick = { vm.refresh() }) { Icon(Icons.Filled.Refresh, contentDescription = "Atualizar", tint = c.textSecondary) }
            })
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            SearchField(vm.query, vm::search, "Nome, código ou código de barras", Modifier.padding(16.dp, 10.dp))
            OfflineBanner(vm.offlineAt)
            when {
                vm.loading && vm.items.isEmpty() -> Loading()
                vm.error != null && vm.items.isEmpty() -> ErrorState(vm.error.orEmpty(), onRetry = { vm.refresh() })
                vm.items.isEmpty() -> EmptyState(Icons.Filled.Inventory2, "Nenhum produto encontrado", subtitle = "Busque pelo nome, pelo código ou toque no leitor para usar a câmera.")
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                    items(vm.items, key = { it.id }) { p ->
                        WbCard(Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("erp.product.row"), onClick = { openProduct(p.id) }) {
                            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(p.name, fontWeight = FontWeight.SemiBold, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                    if (p.subtitle.isNotBlank()) Text(p.subtitle, color = c.textSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 1)
                                }
                                Text(ErpNumbers.showPrice(p.price), color = c.textPrimary)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun ErpProductScreen(container: AppContainer, id: String, onBack: () -> Unit) {
    val access = rememberErpAccess(container)
    if (access == null || !access.products) return PartOff("Produto", ErpParts.PRODUCTS, onBack)
    val vm: ErpProductViewModel = viewModel(key = "erp-product-$id") { ErpProductViewModel(ErpDeps.of(container), id, access) }
    val c = Wb.colors
    val snackbar = remember { SnackbarHostState() }
    var adjusting by remember { mutableStateOf<ErpStockBalance?>(null) }
    LaunchedEffect(vm.done) { vm.done?.let { snackbar.showSnackbar(it); vm.done = null } }
    val product = vm.product
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = { DetailTopBar(product?.name ?: "Produto", onBack, subtitle = product?.subtitle?.ifBlank { null }, actions = { IconButton(onClick = { vm.refresh() }) { Icon(Icons.Filled.Refresh, contentDescription = "Atualizar", tint = c.textSecondary) } }) },
    ) { padding ->
        when {
            product == null && vm.loading -> Loading(Modifier.padding(padding))
            product == null -> ErrorState(vm.error ?: "Produto não encontrado.", onRetry = { vm.refresh() }, Modifier.padding(padding))
            else -> Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
                OfflineBanner(vm.offlineAt)
                vm.photo?.let { bytes ->
                    val bitmap = remember(bytes) { runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }.getOrNull() }
                    if (bitmap != null) Image(bitmap, contentDescription = "Foto de ${product.name}", contentScale = ContentScale.Fit, modifier = Modifier.fillMaxWidth().heightIn(max = 260.dp).padding(16.dp))
                }
                WbCard(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(ErpNumbers.showPrice(product.price), style = MaterialTheme.typography.headlineSmall, color = c.textPrimary, fontWeight = FontWeight.Bold)
                        Field("Unidade", product.unitText)
                        product.code.clean()?.let { Field("Código", it) }
                        product.gtin.clean()?.let { Field("Código de barras", it) }
                        product.brand.clean()?.let { Field("Marca", it) }
                        product.description.clean()?.let { Text(it, color = c.textSecondary, style = MaterialTheme.typography.bodySmall) }
                    }
                }
                if (access.stock) {
                    SectionLabel("Saldo por depósito")
                    val balances = vm.balances
                    WbCard(Modifier.padding(horizontal = 16.dp)) {
                        Column(Modifier.padding(vertical = 6.dp)) {
                            when {
                                vm.stockNote != null -> Text(vm.stockNote.orEmpty(), color = c.textSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(14.dp))
                                balances == null -> Text("Carregando…", color = c.textSecondary, modifier = Modifier.padding(14.dp))
                                balances.isEmpty() -> Text("Nenhum depósito com este produto.", color = c.textSecondary, modifier = Modifier.padding(14.dp))
                                else -> balances.forEachIndexed { index, b ->
                                    if (index > 0) RowDivider(16.dp)
                                    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                        Column(Modifier.weight(1f)) {
                                            Text(b.warehouseName + if (b.warehouseDefault) " (padrão)" else "", color = c.textPrimary)
                                            val reserved = ErpNumbers.showQuantity(b.reservedQuantity)
                                            if (reserved != "0") Text("Reservado: $reserved", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                                        }
                                        Text("${ErpNumbers.showQuantity(b.quantity)} ${b.unit ?: product.unitText}", fontWeight = FontWeight.SemiBold, color = if ((b.quantity.toBigDecimalOrNull()?.signum() ?: 0) < 0) c.danger else c.textPrimary)
                                        if (access.canAdjustStock && vm.offlineAt == null && !b.virtual && b.warehouseActive) {
                                            Spacer(Modifier.width(6.dp))
                                            IconButton(onClick = { vm.adjustError = null; adjusting = b }, modifier = Modifier.testTag("erp.stock.adjust")) { Icon(Icons.Filled.Add, contentDescription = "Ajustar estoque em ${b.warehouseName}", tint = c.brand) }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if (access.canAdjustStock) Text("Toque em + para lançar entrada ou saída com motivo.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 24.dp, vertical = 6.dp))
                }
            }
        }
    }
    adjusting?.let { balance -> StockAdjustSheet(vm, balance, product?.unitText ?: "UN", onDismiss = { adjusting = null }) }
}

@Composable
private fun StockAdjustSheet(vm: ErpProductViewModel, balance: ErpStockBalance, unit: String, onDismiss: () -> Unit) {
    var direction by remember { mutableStateOf(ErpStockDirection.IN) }
    var quantity by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    WbBottomSheet(onDismiss, title = "Ajustar estoque", subtitle = "${balance.warehouseName} · saldo ${ErpNumbers.showQuantity(balance.quantity)} $unit") {
        Column(Modifier.padding(horizontal = 20.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ErpStockDirection.entries.forEach { d -> WbFilterChip(d.label, direction == d, { direction = d }) }
            }
            OutlinedTextField(quantity, { quantity = it }, label = { Text("Quantidade ($unit)") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth().testTag("erp.stock.quantity"))
            OutlinedTextField(reason, { reason = it }, label = { Text("Motivo *") }, placeholder = { Text("Contagem, avaria, troca…") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("erp.stock.reason"))
            vm.adjustError?.let { InlineNotice(it) }
            PrimaryButton("Lançar ${direction.label.lowercase()}", { vm.adjust(direction, balance, quantity, reason, onDismiss) }, loading = vm.saving, modifier = Modifier.testTag("erp.stock.save"))
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Pedido rápido
// ---------------------------------------------------------------------------------------------------------------

@Composable
fun ErpQuickOrderScreen(container: AppContainer, onBack: () -> Unit) {
    val access = rememberErpAccess(container)
    if (access?.quickOrder != true) return PartOff("Pedido rápido", ErpParts.SALES, onBack, roleNote = access != null && ErpParts.SALES in access.parts && ErpParts.PRODUCTS in access.parts)
    val vm: ErpQuickOrderViewModel = viewModel { ErpQuickOrderViewModel(ErpDeps.of(container)) }
    val c = Wb.colors
    val snackbar = remember { SnackbarHostState() }
    val scan = rememberBarcodeScan(onResult = { vm.scan(it) }, onDenied = { vm.notice = ErpText.CAMERA_DENIED })
    LaunchedEffect(vm.notice) { vm.notice?.let { snackbar.showSnackbar(it); vm.notice = null } }
    val saved = vm.saved
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = { DetailTopBar("Pedido rápido", onBack) },
    ) { padding ->
        if (saved != null) {
            Column(Modifier.padding(padding).fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                WbCard {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("Pedido ${saved.number ?: ""} salvo", style = MaterialTheme.typography.titleLarge, color = c.textPrimary)
                        Text("${vm.customer?.name.orEmpty()} · ${Money.format(vm.savedTotal)}", color = c.textSecondary)
                        saved.status?.let { Text(ErpText.saleStatus(it), color = c.textSecondary, style = MaterialTheme.typography.bodySmall) }
                    }
                }
                val preview = vm.preview
                when {
                    vm.sent != null -> InlineNotice(vm.sent.orEmpty(), color = c.ok)
                    preview?.canSend == true -> PrimaryButton(
                        "Enviar ao cliente pelo WhatsApp", { vm.send() }, loading = vm.sending, icon = Icons.Filled.Send, modifier = Modifier.testTag("erp.order.send"),
                    )
                    preview?.destino?.motivo != null -> Text(preview?.destino?.motivo.orEmpty(), color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                    preview?.conectar != null -> Text(preview?.conectar.orEmpty(), color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                }
                vm.error?.let { InlineNotice(it, onDismiss = { vm.error = null }) }
                SecondaryButton("Novo pedido", { vm.reset() })
            }
            return@Scaffold
        }
        LazyColumn(Modifier.padding(padding).fillMaxSize().imePadding(), contentPadding = PaddingValues(bottom = 32.dp)) {
            item("customer-label") { SectionLabel("Cliente") }
            item("customer") {
                val chosen = vm.customer
                Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (chosen != null) {
                        WbCard {
                            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(chosen.name, color = c.textPrimary, fontWeight = FontWeight.SemiBold)
                                    if (chosen.subtitle.isNotBlank()) Text(chosen.subtitle, color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                                }
                                IconButton(onClick = { vm.customer = null }) { Icon(Icons.Filled.Close, contentDescription = "Trocar cliente", tint = c.textSecondary) }
                            }
                        }
                    } else {
                        SearchField(vm.customerQuery, vm::searchCustomer, "Buscar cliente pelo nome ou CPF/CNPJ", Modifier.testTag("erp.order.customer"))
                        vm.customerResults.forEach { item ->
                            WbCard(onClick = { vm.chooseCustomer(item) }) {
                                Column(Modifier.padding(12.dp)) {
                                    Text(item.name, color = c.textPrimary)
                                    if (item.subtitle.isNotBlank()) Text(item.subtitle, color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                                }
                            }
                        }
                    }
                }
            }
            item("items-label") { SectionLabel("Itens") }
            item("product-search") {
                Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    SearchField(vm.productQuery, vm::searchProduct, "Produto: nome ou código", Modifier.weight(1f).testTag("erp.order.product"))
                    IconButton(onClick = scan) { Icon(Icons.Filled.QrCodeScanner, contentDescription = "Ler código de barras", tint = c.brand) }
                }
            }
            items(vm.productResults, key = { "result-" + it.id }) { p ->
                WbCard(Modifier.padding(horizontal = 16.dp, vertical = 3.dp), onClick = { vm.add(p) }) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(p.name, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (p.subtitle.isNotBlank()) Text(p.subtitle, color = c.textSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 1)
                        }
                        Text(ErpNumbers.showPrice(p.price), color = c.textPrimary)
                        Icon(Icons.Filled.Add, contentDescription = "Incluir", tint = c.brand)
                    }
                }
            }
            items(vm.lines, key = { "line-" + it.product.id }) { line -> CartLineRow(vm, line) }
            if (vm.lines.isEmpty()) item("empty") {
                Text("Busque o produto ou leia o código de barras para incluir.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
            }
            item("discount-label") { SectionLabel("Desconto e pagamento") }
            item("discount") {
                Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(vm.discountText, { vm.discountText = it }, label = { Text(if (vm.discountPercent) "Desconto (%)" else "Desconto (R$)") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f))
                        WbFilterChip("R$", !vm.discountPercent, { vm.discountPercent = false })
                        WbFilterChip("%", vm.discountPercent, { vm.discountPercent = true })
                    }
                    if (vm.methods.isNotEmpty()) LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(vm.methods, key = { it.id }) { m -> WbFilterChip(m.description.ifBlank { "Forma" }, vm.methodId == m.id, { vm.methodId = m.id }) }
                    }
                    vm.methodsNote?.let { Text(it, color = c.textSecondary, style = MaterialTheme.typography.bodySmall) }
                }
            }
            item("total") {
                val t = vm.totals
                WbCard(Modifier.padding(16.dp)) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (t == null) Text("Confira o desconto.", color = c.danger)
                        else {
                            Field("Produtos", Money.format(t.subtotal))
                            if (t.discount > 0) Field("Desconto", "- " + Money.format(t.discount))
                            Row { Text("Total", fontWeight = FontWeight.Bold, color = c.textPrimary, modifier = Modifier.weight(1f)); Text(Money.format(t.total), fontWeight = FontWeight.Bold, color = c.textPrimary) }
                            if (!t.valid) Text("O desconto é maior que o valor dos produtos.", color = c.danger, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
            item("save") {
                Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    vm.error?.let { InlineNotice(it, onDismiss = { vm.error = null }) }
                    PrimaryButton("Salvar pedido de venda", { vm.save() }, loading = vm.saving, enabled = vm.customer != null && vm.lines.isNotEmpty(), modifier = Modifier.testTag("erp.order.save"))
                }
            }
        }
    }
}

@Composable
private fun CartLineRow(vm: ErpQuickOrderViewModel, line: ErpCartLine) {
    val c = Wb.colors
    var text by remember(line.product.id) { mutableStateOf(line.quantity.replace(".", ",")) }
    var invalid by remember(line.product.id) { mutableStateOf(false) }
    val price = ErpNumbers.unitPrice(line.product.price)
    WbCard(Modifier.padding(horizontal = 16.dp, vertical = 3.dp)) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(line.product.name, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(
                    "${ErpNumbers.showPrice(line.product.price)} / ${line.product.unitText}" + (price?.let { " · " + Money.format(ErpNumbers.lineCents(line.quantity, it)) } ?: ""),
                    color = c.textSecondary, style = MaterialTheme.typography.bodySmall,
                )
            }
            OutlinedTextField(
                text, { text = it; invalid = !vm.setQuantity(line.product.id, it) },
                singleLine = true, isError = invalid, label = { Text("Qtd.") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.width(92.dp),
            )
            IconButton(onClick = { vm.remove(line.product.id) }) { Icon(Icons.Filled.Close, contentDescription = "Tirar ${line.product.name}", tint = c.textSecondary) }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Contas
// ---------------------------------------------------------------------------------------------------------------

@Composable
fun ErpBillsScreen(container: AppContainer, onBack: () -> Unit) {
    val access = rememberErpAccess(container)
    if (access == null || !access.bills) return PartOff("Contas", ErpParts.FINANCE, onBack, roleNote = access != null && ErpParts.FINANCE in access.parts)
    val vm: ErpBillsViewModel = viewModel { ErpBillsViewModel(ErpDeps.of(container)) }
    val c = Wb.colors
    val snackbar = remember { SnackbarHostState() }
    var settling by remember { mutableStateOf<ErpTitle?>(null) }
    LaunchedEffect(vm.done) { vm.done?.let { snackbar.showSnackbar(it); vm.done = null } }
    Scaffold(
        containerColor = c.background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = { DetailTopBar("Contas", onBack, actions = { IconButton(onClick = { vm.refresh() }) { Icon(Icons.Filled.Refresh, contentDescription = "Atualizar", tint = c.textSecondary) } }) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            Row(Modifier.padding(16.dp, 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                WbFilterChip("A receber", vm.kind == "receivable", { vm.select(kind = "receivable") })
                WbFilterChip("A pagar", vm.kind == "payable", { vm.select(kind = "payable") })
            }
            Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ErpBillsViewModel.Filter.entries.forEach { f -> WbFilterChip(f.label, vm.filter == f, { vm.select(filter = f) }) }
            }
            OfflineBanner(vm.offlineAt)
            when {
                vm.loading && vm.items.isEmpty() -> Loading()
                vm.error != null && vm.items.isEmpty() -> ErrorState(vm.error.orEmpty(), onRetry = { vm.refresh() })
                vm.items.isEmpty() -> EmptyState(
                    Icons.Filled.AccountBalanceWallet,
                    if (vm.filter == ErpBillsViewModel.Filter.TODAY) "Nada vencendo hoje" else "Nada vencido",
                    subtitle = if (vm.kind == "receivable") "Nenhuma conta a receber aqui." else "Nenhuma conta a pagar aqui.",
                )
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp)) {
                    item("sum") {
                        Text(
                            "${vm.items.size} conta(s) · ${Money.format(vm.items.sumOf { it.balance })}",
                            color = c.textSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
                        )
                    }
                    items(vm.items, key = { it.id }) { t ->
                        WbCard(Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("erp.bill.row")) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(t.contactName.ifBlank { "Sem contato" }, fontWeight = FontWeight.SemiBold, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                TitleLine(t)
                                if (access.canSettle && vm.offlineAt == null) {
                                    SecondaryButton(if (t.kind == "payable") "Dar baixa (paguei)" else "Dar baixa (recebi)", { vm.settleError = null; vm.loadAccounts(); settling = t }, modifier = Modifier.testTag("erp.bill.settle"))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    settling?.let { title -> SettleSheet(vm, title, onDismiss = { settling = null }) }
}

@Composable
private fun SettleSheet(vm: ErpBillsViewModel, title: ErpTitle, onDismiss: () -> Unit) {
    val c = Wb.colors
    var accountId by remember(title.id) { mutableStateOf(title.accountId) }
    LaunchedEffect(vm.accounts) { if (accountId == null || vm.accounts.none { it.id == accountId }) accountId = vm.accounts.firstOrNull()?.id }
    WbBottomSheet(onDismiss, title = "Dar baixa", subtitle = "${title.contactName} · ${Money.format(title.balance)} · hoje") {
        Column(Modifier.padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Conta financeira", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
            if (vm.accounts.isEmpty() && vm.settleError == null) Text("Carregando as contas…", color = c.textSecondary)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(vm.accounts, key = { it.id }) { a -> WbFilterChip(a.name.ifBlank { "Conta" }, accountId == a.id, { accountId = a.id }) }
            }
            Text("A baixa é do saldo inteiro, com a data de hoje. Juros, multa, desconto e baixa parcial ficam no painel.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
            vm.settleError?.let { InlineNotice(it) }
            PrimaryButton("Confirmar baixa de ${Money.format(title.balance)}", { vm.settle(title, accountId, onDismiss) }, loading = vm.saving, enabled = accountId != null, modifier = Modifier.testTag("erp.bill.confirm"))
        }
    }
}
