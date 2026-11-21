import SwiftUI
import UIKit

/*
 As telas da ordem de serviço por modelo, no mesmo desenho do Android (`modules/os/WorkOrderScreens.kt`): a lista com
 filtro de modelo, situação, etapa e busca; a abertura com modelo, cliente do cadastro, objeto do serviço e campos
 próprios; e a ficha com etapas (avançar, voltar e cancelar com motivo), checklist com foto pela câmera, campos,
 objeto, orçamento só leitura e histórico. Servidor sem modelos, catálogo só com a ordem simples e ordens do modelo
 simples continuam nas telas antigas (`ServiceOrderViews.swift`). Sem conexão, tudo vira leitura da cópia guardada.
 */

// MARK: - Lista

/// Entrada "Ordens de serviço": a lista por modelo ou, num servidor sem modelos, a lista antiga.
struct WorkOrdersView: View {
    @StateObject private var vm: WorkOrdersViewModel
    @Environment(\.pushRoute) private var push
    @State private var search = ""
    @FocusState private var searching: Bool

    init(vm: WorkOrdersViewModel? = nil) {
        _vm = StateObject(wrappedValue: vm ?? WorkOrdersViewModel())
    }

    var body: some View {
        Group {
            switch vm.mode {
            case .legacy:
                ServiceOrdersView()
            case .loading:
                SkeletonList(rows: 6, avatar: false)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .background(Theme.background.ignoresSafeArea())
                    .navigationTitle("Ordens de serviço")
                    .navigationBarTitleDisplayMode(.inline)
                    .appNavigationBarHidden(false)
            case .failed(let message):
                VStack { InlineError(text: message) { Task { await vm.start() } }.padding(16); Spacer() }
                    .background(Theme.background.ignoresSafeArea())
                    .navigationTitle("Ordens de serviço")
                    .navigationBarTitleDisplayMode(.inline)
                    .appNavigationBarHidden(false)
            case .ready:
                list
            }
        }
        .task { vm.observeEvents(); await vm.start() }
    }

    private var list: some View {
        VStack(spacing: 0) {
            VStack(spacing: 10) {
                SearchField(placeholder: "Número, cliente ou item", text: $search, focused: $searching)
                    .accessibilityIdentifier("wo.search")
                if vm.types.count > 1 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            FilterChip(title: "Todos os modelos", selected: vm.typeId == nil) { vm.setType(nil) }
                            ForEach(vm.types) { t in
                                FilterChip(title: t.isBuiltin ? "Ordem de serviço (simples)" : t.name, selected: vm.typeId == t.id) { vm.setType(t.id) }
                                    .accessibilityIdentifier("wo.type.\(t.id)")
                            }
                        }
                    }
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(WorkOrderRules.Situation.allCases) { s in
                            FilterChip(title: s.title, selected: vm.stage == nil && vm.situation == s) { vm.setSituation(s) }
                                .accessibilityIdentifier("wo.situation.\(s.rawValue)")
                        }
                    }
                }
                if let type = vm.selectedType, !type.isBuiltin, !vm.stages.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(vm.stages) { s in
                                FilterChip(title: s.title, selected: vm.stage == s.id) { vm.setStage(vm.stage == s.id ? nil : s.id) }
                                    .accessibilityIdentifier("wo.stage.\(s.id)")
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Theme.bar)
            .overlay(alignment: .bottom) { ThinDivider() }
            if let since = vm.offlineSince {
                DeviceNotice(text: WorkOrderRules.offlineBanner(since), color: Theme.warn).padding(.horizontal, 16).padding(.top, 8)
            }
            content.frame(maxHeight: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Ordens de serviço")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                if vm.offlineSince == nil {
                    Button { push(.newServiceOrder(conversationId: nil, customer: nil)) } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Nova ordem de serviço")
                        .accessibilityIdentifier("wo.new")
                }
            }
        }
        .onChange(of: search) { vm.search($0) }
    }

    @ViewBuilder
    private var content: some View {
        if vm.loading && vm.orders.isEmpty {
            SkeletonList(rows: 6, avatar: false)
        } else if let error = vm.error, vm.orders.isEmpty {
            VStack { InlineError(text: error) { Task { await vm.load() } }.padding(16); Spacer() }
        } else if vm.orders.isEmpty {
            EmptyStateView(title: "Nenhuma ordem aqui", systemImage: "wrench.and.screwdriver",
                           message: vm.query.isEmpty ? "Toque em + para abrir uma ordem, ou abra pela conversa do cliente." : "Nada encontrado para essa busca.")
        } else {
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(vm.orders) { order in
                        Button { push(.serviceOrder(id: order.id)) } label: { WorkOrderRow(order: order, showsType: vm.showsTypeLabel) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("wo.order.\(order.id)")
                            .onAppear { if order.id == vm.orders.last?.id { Task { await vm.loadMore() } } }
                    }
                    if vm.loadingMore { ProgressView().padding() }
                }
                .padding(16)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .refreshable { await vm.load() }
        }
    }
}

private struct WorkOrderRow: View {
    let order: WorkOrder
    let showsType: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(order.numberText).font(.system(size: 15, weight: .bold, design: .rounded)).foregroundStyle(Theme.ticket)
                if showsType, let type = order.typeLabel, !type.isEmpty {
                    Text("· \(type)").font(Theme.font(12)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                }
                Spacer()
                Pill(text: order.stageText, color: ServiceOrderRules.color(order.state))
            }
            Text(order.customerName).font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
            if let item = order.item, !item.isEmpty {
                Text(item).font(Theme.font(14)).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
            if let identifier = order.object?.identifier, !identifier.isEmpty {
                Label(identifier, systemImage: "tag.fill").font(Theme.font(13)).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
            HStack(spacing: 8) {
                if let due = order.dueAt, !order.isClosed { Text("Prazo \(BrasiliaTime.short(due))").font(Theme.font(12)).foregroundStyle(Theme.textSecondary) }
                if let quote = order.quote { Text("Orçamento \(Money.format(WorkOrderRules.quoteTotal(quote)))").font(Theme.font(12, .semibold)).foregroundStyle(Theme.textPrimary) }
                Spacer()
                if WorkOrderRules.isOverdue(order) { Pill(text: "Atrasado", color: Theme.danger) }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.surface))
        .contentShape(Rectangle())
    }
}

// MARK: - Campos próprios

/// O editor dos campos comuns (nunca os restritos): um controle por tipo, como no painel.
struct WorkFieldsEditor: View {
    let fields: [WorkField]
    @Binding var draft: [String: String]
    var required: Set<String> = []
    var hints: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(WorkFields.visible(fields)) { field in
                fieldView(field)
                    .accessibilityIdentifier("wo.field.\(field.id)")
            }
        }
    }

    private func binding(_ id: String) -> Binding<String> {
        Binding(get: { draft[id] ?? "" }, set: { draft[id] = $0 })
    }

    private func label(_ field: WorkField) -> String {
        field.title + (required.contains(field.id) || field.isRequired ? " *" : "") + (hints.contains(field.id) ? " (pedido na próxima etapa)" : "")
    }

    @ViewBuilder
    private func fieldView(_ field: WorkField) -> some View {
        let isRequired = required.contains(field.id) || field.isRequired
        VStack(alignment: .leading, spacing: 6) {
            switch field.type {
            case "boolean":
                choices(label(field), options: [("true", "Sim"), ("false", "Não")], id: field.id, clearable: !isRequired)
            case "choice":
                choices(label(field), options: (field.options ?? []).map { ($0.id, $0.label ?? $0.id) }, id: field.id, clearable: !isRequired)
            case "date":
                dateField(field, clearable: !isRequired)
            case "integer", "decimal":
                AuthField(label: label(field)) {
                    TextField(field.type == "integer" ? "0" : "0,00", text: binding(field.id))
                        .keyboardType(field.type == "integer" ? .numberPad : .decimalPad)
                }
            default:
                AuthField(label: label(field)) {
                    if field.multiline == true {
                        AppMultilineField(field.title, text: limited(field), lines: 2...6).padding(.vertical, 10)
                    } else {
                        TextField(field.title, text: limited(field))
                    }
                }
            }
            if let help = field.help, !help.isEmpty {
                Text(help).font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
            }
        }
    }

    private func limited(_ field: WorkField) -> Binding<String> {
        Binding(get: { draft[field.id] ?? "" }, set: { value in
            if let max = field.maxLength, max > 0, value.count > max { draft[field.id] = String(value.prefix(max)) } else { draft[field.id] = value }
        })
    }

    private func choices(_ title: String, options: [(String, String)], id: String, clearable: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(Theme.font(13, .semibold)).foregroundStyle(Theme.textSecondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(options, id: \.0) { option in
                        FilterChip(title: option.1, selected: (draft[id] ?? "") == option.0) { draft[id] = option.0 }
                    }
                    if clearable {
                        FilterChip(title: "Não informado", selected: (draft[id] ?? "").isEmpty) { draft[id] = "" }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func dateField(_ field: WorkField, clearable: Bool) -> some View {
        let value = draft[field.id] ?? ""
        VStack(alignment: .leading, spacing: 6) {
            Text(label(field)).font(Theme.font(13, .semibold)).foregroundStyle(Theme.textSecondary)
            HStack {
                if let date = WorkFields.date(from: value), WorkFields.isValidDay(value) {
                    DatePicker("", selection: Binding(get: { date }, set: { draft[field.id] = WorkFields.day(from: $0) }), displayedComponents: .date)
                        .labelsHidden()
                        .environment(\.locale, Locale(identifier: "pt_BR"))
                        .environment(\.timeZone, BrasiliaTime.zone)
                    Spacer()
                    if clearable { Button("Limpar") { draft[field.id] = "" }.font(Theme.font(14)).foregroundStyle(Theme.textSecondary) }
                } else {
                    Text("Sem data").font(Theme.font(15)).foregroundStyle(Theme.textSecondary)
                    Spacer()
                    Button("Escolher data") { draft[field.id] = WorkFields.day(from: Date()) }.font(Theme.font(14, .semibold)).foregroundStyle(Theme.brand)
                }
            }
            .frame(minHeight: Theme.touch)
        }
    }
}

// MARK: - Ficha

/// Um documento aberto em "Ver foto".
private struct WorkPhotoRef: Identifiable, Equatable { let id: String }

/// Ficha da ordem por modelo; a ordem do modelo simples abre a ficha antiga.
struct WorkOrderDetailView: View {
    let id: String
    @StateObject private var vm: WorkOrderViewModel
    @Environment(\.pushRoute) private var push
    @State private var reasonFor: WorkNextStage?
    @State private var editing = false
    @State private var editDraft: [String: String] = [:]
    @State private var editError: String?
    @State private var cameraFor: WorkChecklistItem?
    @State private var viewing: WorkPhotoRef?
    @State private var confirmQuote = false

    init(id: String, vm: WorkOrderViewModel? = nil) {
        self.id = id
        _vm = StateObject(wrappedValue: vm ?? WorkOrderViewModel(id: id))
    }

    var body: some View {
        if vm.order?.isLegacy == true {
            ServiceOrderDetailView(id: id)
        } else {
            detail
        }
    }

    private var detail: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let since = vm.offlineSince { DeviceNotice(text: WorkOrderRules.offlineBanner(since), color: Theme.warn) }
                if let order = vm.order {
                    if let notice = vm.notice { InlineError(text: notice).onTapGesture { vm.notice = nil } }
                    if let progress = vm.progress {
                        HStack(spacing: 8) { ProgressView(); Text(progress).font(Theme.font(14)).foregroundStyle(Theme.textSecondary) }
                    }
                    header(order)
                    if let approval = order.stageApproval, approval.state == "pending" {
                        DeviceNotice(text: "Esperando a aprovação do cliente" + (approval.expiresAt.map { " até \(BrasiliaTime.shortWithTime($0))" } ?? "") + ". A decisão é registrada no painel.")
                    }
                    stageButtons(order)
                    checklist(order)
                    fieldsSection(order)
                    objectSection(order)
                    quoteSection(order)
                    customerSection(order)
                    historySection(order)
                } else if vm.loading {
                    SkeletonList(rows: 4, avatar: false)
                } else if let notice = vm.notice {
                    InlineError(text: notice) { Task { await vm.load() } }
                }
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(vm.order?.title.isEmpty == false ? vm.order!.title : "Ordem de serviço")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .task { vm.observeEvents(); await vm.load() }
        .refreshable { await vm.load() }
        .onChange(of: vm.done) { text in if let text { Workspace.shared.show(text, style: .success) } }
        .sheet(item: $reasonFor) { next in
            WorkReasonSheet(
                title: WorkOrderRules.reasonTitle(from: vm.order?.state ?? "", to: next.baseStatus ?? ""),
                confirm: next.baseStatus == "cancelled" ? "Cancelar a ordem" : "Confirmar",
                danger: next.baseStatus == "cancelled"
            ) { reason in
                reasonFor = nil
                vm.changeStage(next, note: reason)
            } onClose: { reasonFor = nil }
        }
        .sheet(isPresented: $editing) { editSheet }
        .sheet(item: $vm.requirements) { request in
            WorkRequirementsSheet(request: request, initial: WorkFields.draft(request.fields, values: vm.order?.extra)) { draft in
                vm.saveRequirements(request, draft: draft)
            } onClose: { vm.requirements = nil }
        }
        .sheet(item: $viewing) { ref in WorkPhotoSheet(load: { await vm.photo(ref.id) }) { viewing = nil } }
        .fullScreenCover(item: $cameraFor) { item in
            WorkCameraPicker(onPicked: { image in vm.markWithPhoto(item, image: image) }, onDone: { cameraFor = nil })
                .ignoresSafeArea()
        }
        .confirmationDialog("Enviar o orçamento ao cliente?", isPresented: $confirmQuote, titleVisibility: .visible) {
            Button("Enviar pelo WhatsApp") { vm.sendQuote() }
            Button("Voltar", role: .cancel) {}
        } message: {
            Text("O cliente recebe os itens, o total e a validade no WhatsApp e responde Aprovar ou Recusar.")
        }
    }

    private func header(_ o: WorkOrder) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(o.numberText).font(.system(size: 22, weight: .bold, design: .rounded)).foregroundStyle(Theme.ticket)
                Spacer()
                Pill(text: o.stageText, color: ServiceOrderRules.color(o.state), filled: true)
            }
            if let type = o.typeLabel, !type.isEmpty { Text(type).font(Theme.font(13, .semibold)).foregroundStyle(Theme.textSecondary) }
            Text(o.item?.isEmpty == false ? o.item! : "—").font(Theme.font(20, .bold)).foregroundStyle(Theme.textPrimary)
            VStack(alignment: .leading, spacing: 4) {
                Text(o.problemLabel).font(Theme.font(12, .semibold)).foregroundStyle(Theme.textSecondary)
                Text(o.problem?.isEmpty == false ? o.problem! : "—").font(Theme.font(15)).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
            }
            if let notes = o.notes, !notes.isEmpty {
                Label(notes, systemImage: "lock.fill").font(Theme.font(13)).foregroundStyle(Theme.noteText)
                    .padding(8).background(RoundedRectangle(cornerRadius: 8).fill(Theme.bubbleNote))
                    .accessibilityLabel("Observação interna: \(notes)")
            }
            HStack(spacing: 14) {
                if let created = o.created { Label(BrasiliaTime.short(created), systemImage: "calendar") }
                if let due = o.dueAt, !o.isClosed {
                    Label("Prazo \(BrasiliaTime.short(due))" + (WorkOrderRules.isOverdue(o) ? " · Atrasado" : ""), systemImage: "clock")
                        .foregroundStyle(WorkOrderRules.isOverdue(o) ? Theme.danger : Theme.textSecondary)
                }
            }
            .font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
        }
        .card(padding: 16)
    }

    @ViewBuilder
    private func stageButtons(_ o: WorkOrder) -> some View {
        let buttons = WorkOrderRules.stageButtons(o)
        if vm.canChange, !buttons.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("O que fazer agora").font(Theme.font(13, .semibold)).foregroundStyle(Theme.textSecondary)
                ForEach(buttons, id: \.next.transitionId) { button in
                    SecondaryButton(title: button.title, color: button.danger ? Theme.danger : Theme.brand,
                                    busy: vm.busy == "stage:\(button.next.transitionId)", disabled: vm.busy != nil) {
                        if WorkOrderRules.needsReason(from: o.state, to: button.next.baseStatus ?? "") { reasonFor = button.next }
                        else { vm.changeStage(button.next, note: nil) }
                    }
                    .accessibilityIdentifier("wo.stage.\(button.next.transitionId)")
                }
            }
        }
    }

    @ViewBuilder
    private func checklist(_ o: WorkOrder) -> some View {
        let stages = o.checklist ?? []
        if !stages.isEmpty {
            SectionCard(title: "Checklist") {
                ForEach(Array(stages.enumerated()), id: \.element.id) { index, stage in
                    VStack(alignment: .leading, spacing: 0) {
                        Text((stage.stageLabel ?? stage.stageId) + (stage.current == true ? " · etapa atual" : ""))
                            .font(Theme.font(14, .semibold))
                            .foregroundStyle(stage.current == true ? Theme.textPrimary : Theme.textSecondary)
                            .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 4)
                        ForEach(stage.items ?? []) { item in checklistRow(item, stage: stage, order: o) }
                        if stage.current == true, let missing = WorkOrderRules.missingText(stage) {
                            Text(missing).font(Theme.font(12)).foregroundStyle(Theme.warn)
                                .padding(.horizontal, 14).padding(.bottom, 10)
                        }
                        if index < stages.count - 1 { ThinDivider(onCard: true) }
                    }
                }
            }
        }
    }

    private func checklistRow(_ item: WorkChecklistItem, stage: WorkChecklistStage, order: WorkOrder) -> some View {
        let done = item.done == true
        let canMark = vm.canChange && stage.current == true
        return HStack(spacing: 10) {
            Button {
                if !done && item.photoRequired == true {
                    if WorkCameraPicker.canUse { cameraFor = item } else { vm.notice = WorkOrderRules.noCamera }
                } else {
                    vm.toggle(item)
                }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: done ? "checkmark.square.fill" : "square")
                        .font(.system(size: 20)).foregroundStyle(done ? Theme.brand : Theme.muted)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title + (item.required == true ? " (obrigatório)" : "") + (item.photoRequired == true ? " · pede foto" : ""))
                            .font(Theme.font(15)).foregroundStyle(Theme.textPrimary).multilineTextAlignment(.leading)
                        if done, let at = item.at { Text("Marcado em \(BrasiliaTime.shortWithTime(at))").font(Theme.font(12)).foregroundStyle(Theme.textSecondary) }
                    }
                    Spacer(minLength: 0)
                    if !done && item.photoRequired == true && canMark { Image(systemName: "camera.fill").foregroundStyle(Theme.textSecondary) }
                }
            }
            .buttonStyle(.plain)
            .disabled(!canMark)
            .accessibilityIdentifier("wo.check.\(item.id)")
            if done, let doc = item.photoDocumentId, !doc.isEmpty {
                Button("Ver foto") { viewing = WorkPhotoRef(id: doc) }.font(Theme.font(14, .semibold)).foregroundStyle(Theme.brand)
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: Theme.touch)
    }

    @ViewBuilder
    private func fieldsSection(_ o: WorkOrder) -> some View {
        let fields = WorkFields.visible(o.fields)
        if !fields.isEmpty {
            let asked = vm.askedNext
            SectionCard(title: "Campos desta ordem") {
                ForEach(Array(fields.enumerated()), id: \.element.id) { index, field in
                    CardRow(title: field.title + (asked.contains(field.id) ? " (pedido na próxima etapa)" : ""),
                            value: WorkFields.display(field, o.extra?[field.id]),
                            titleColor: asked.contains(field.id) ? Theme.warn : Theme.textPrimary,
                            divider: index < fields.count - 1 || vm.canChange)
                }
                if vm.canChange {
                    Button {
                        editDraft = WorkFields.draft(o.fields, values: o.extra)
                        editError = nil
                        editing = true
                    } label: { CardRow(icon: "pencil", iconColor: Theme.ticket, title: "Editar campos", chevron: true, divider: false) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("wo.fields.edit")
                }
            }
        }
    }

    private var editSheet: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Editar campos") { editing = false }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    WorkFieldsEditor(fields: vm.order?.fields ?? [], draft: $editDraft,
                                     required: WorkFields.requiredNow(vm.type, stage: vm.order?.stage, fields: vm.order?.fields), hints: vm.askedNext)
                    if let editError { InlineError(text: editError) }
                    PrimaryButton(title: "Salvar campos", icon: "checkmark", busy: vm.busy == "fields", disabled: vm.busy != nil) {
                        if let message = vm.saveFields(draft: editDraft) { editError = message } else { editing = false }
                    }
                    .accessibilityIdentifier("wo.fields.save")
                }
                .padding(16)
            }
        }
        .background(Theme.background.ignoresSafeArea())
    }

    @ViewBuilder
    private func objectSection(_ o: WorkOrder) -> some View {
        if let object = o.object {
            let fields = WorkFields.visible(object.type?.fields).filter { $0.id != object.type?.identifierFieldId }
            SectionCard(title: object.type?.singular ?? "Objeto do serviço") {
                CardRow(icon: "tag.fill", iconColor: Theme.bot, title: object.identifier?.isEmpty == false ? object.identifier! : (object.type?.singular ?? "Objeto"), divider: !fields.isEmpty)
                ForEach(Array(fields.enumerated()), id: \.element.id) { index, field in
                    CardRow(title: field.title, value: WorkFields.display(field, object.values?[field.id]), divider: index < fields.count - 1)
                }
            }
        }
    }

    @ViewBuilder
    private func quoteSection(_ o: WorkOrder) -> some View {
        if let quote = o.quote {
            SectionCard(title: "Orçamento", footer: [WorkOrderRules.quoteStatus(o), quote.note ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")) {
                ForEach(Array((quote.items ?? []).enumerated()), id: \.offset) { _, item in
                    CardRow(title: item.description ?? "Item",
                            subtitle: (item.quantity ?? 1) == 1 ? nil : "\(WorkFields.numberText(item.quantity ?? 1)) × \(Money.format(item.unitCents ?? 0))",
                            value: Money.format(item.lineCents))
                }
                if let discount = quote.discountCents, discount > 0 {
                    CardRow(title: "Desconto", value: "-" + Money.format(discount))
                }
                let canSend = vm.canChange && WorkOrderRules.canSendQuote(o)
                CardRow(title: "Total", value: Money.format(WorkOrderRules.quoteTotal(quote)), titleColor: Theme.textPrimary, divider: canSend)
                if canSend {
                    Button { confirmQuote = true } label: {
                        CardRow(icon: "paperplane.fill", iconColor: Theme.ok, title: "Enviar ao cliente pelo WhatsApp", chevron: true, divider: false)
                    }
                    .buttonStyle(.plain)
                    .disabled(vm.busy != nil)
                    .accessibilityIdentifier("wo.quote.send")
                }
            }
        }
    }

    private func customerSection(_ o: WorkOrder) -> some View {
        SectionCard(title: o.labels?.customerSingular?.isEmpty == false ? o.labels!.customerSingular! : "Cliente") {
            let conversation = o.customer?.conversationId
            CardRow(icon: "person.fill", iconColor: Theme.brand, title: o.customerName, subtitle: PhoneText.display(o.customer?.phone), divider: conversation != nil)
            if let conversation, !conversation.isEmpty {
                Button { push(.conversation(id: conversation)) } label: {
                    CardRow(icon: "bubble.left.and.bubble.right.fill", iconColor: Theme.ok, title: "Abrir conversa", chevron: true, divider: false)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func historySection(_ o: WorkOrder) -> some View {
        let entries = vm.history.sorted { ($0.created ?? 0) > ($1.created ?? 0) }
        let stages = vm.type?.stages
        let more = vm.historyCursor != nil && !vm.readOnly
        return SectionCard(title: "Histórico") {
            if entries.isEmpty { CardRow(title: "Sem registros ainda.", divider: false) }
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, h in
                CardRow(icon: "clock.arrow.circlepath", iconColor: ServiceOrderRules.color(h.toStatus ?? ""),
                        title: WorkOrderRules.historyText(h, stages: stages),
                        subtitle: WorkOrderRules.historyNote(h).map { "Motivo: \($0)" },
                        value: h.created.map(BrasiliaTime.shortWithTime),
                        divider: index < entries.count - 1 || more)
            }
            if more {
                Button { Task { await vm.loadMoreHistory() } } label: { CardRow(title: "Ver mais", titleColor: Theme.brand, divider: false) }
                    .buttonStyle(.plain)
            }
        }
    }
}

/// Motivo para voltar ou cancelar: obrigatório, vai para o histórico.
private struct WorkReasonSheet: View {
    let title: String
    let confirm: String
    let danger: Bool
    let onConfirm: (String) -> Void
    let onClose: () -> Void
    @State private var reason = ""
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SheetHeader(title: title) { onClose() }
            AuthField(label: "Motivo", error: error != nil) {
                AppMultilineField("Ex.: cliente pediu para parar", text: $reason, lines: 2...5).padding(.vertical, 10)
            }
            .accessibilityIdentifier("wo.reason")
            Text(error ?? "Fica no histórico da ordem, com quem fez e quando.")
                .font(Theme.font(13)).foregroundStyle(error != nil ? Theme.danger : Theme.textSecondary)
            PrimaryButton(title: confirm, color: danger ? Theme.danger : Theme.brand) {
                let text = reason.trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty { error = WorkOrderRules.emptyReason } else { onConfirm(String(text.prefix(500))) }
            }
            .accessibilityIdentifier("wo.reason.confirm")
            Spacer()
        }
        .padding(.horizontal, 20)
        .background(Theme.background.ignoresSafeArea())
        .onChange(of: reason) { _ in error = nil }
    }
}

/// "Complete os dados desta etapa": os campos que a mudança de etapa pede; salva e repete a mudança.
private struct WorkRequirementsSheet: View {
    let request: WorkRequirementsRequest
    let onSave: ([String: String]) -> String?
    let onClose: () -> Void
    @State private var draft: [String: String]
    @State private var error: String?

    init(request: WorkRequirementsRequest, initial: [String: String], onSave: @escaping ([String: String]) -> String?, onClose: @escaping () -> Void) {
        self.request = request
        self.onSave = onSave
        self.onClose = onClose
        _draft = State(initialValue: initial)
    }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Complete os dados desta etapa", subtitle: "Para \(request.next.stageLabel ?? request.next.stage ?? "a próxima etapa")") { onClose() }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    WorkFieldsEditor(fields: request.fields, draft: $draft, required: Set(request.fields.map(\.id)))
                    if request.internalMissing {
                        DeviceNotice(text: "Também falta um dado restrito desta ordem. Peça a quem tem acesso para completar no painel.")
                    }
                    if let error { InlineError(text: error) }
                    if !request.fields.isEmpty {
                        PrimaryButton(title: "Salvar e tentar de novo", icon: "arrow.clockwise") {
                            if let message = onSave(draft) { error = message }
                        }
                        .accessibilityIdentifier("wo.requirements.save")
                    }
                }
                .padding(16)
            }
        }
        .background(Theme.background.ignoresSafeArea())
    }
}

/// A foto de um item do checklist, baixada com o token.
private struct WorkPhotoSheet: View {
    let load: () async -> Data?
    let onClose: () -> Void
    @State private var image: UIImage?
    @State private var loading = true

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "Foto do checklist") { onClose() }
            Group {
                if let image {
                    Image(uiImage: image).resizable().scaledToFit().accessibilityLabel("Foto do item do checklist")
                } else if loading {
                    ProgressView()
                } else {
                    Text("Não deu para abrir a foto.").font(Theme.font(15)).foregroundStyle(Theme.textSecondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(16)
        }
        .background(Theme.background.ignoresSafeArea())
        .task {
            if let data = await load() { image = UIImage(data: data) }
            loading = false
        }
    }
}

// MARK: - Abertura

/// Abrir ordem por modelo. Servidor sem modelos, catálogo só com a ordem simples ou a escolha da ordem simples abrem a
/// tela antiga.
struct NewWorkOrderView: View {
    let conversationId: String?
    let customer: String?
    @StateObject private var vm: NewWorkOrderViewModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.pushRoute) private var push
    @FocusState private var searching: Bool

    init(conversationId: String?, customer: String?, vm: NewWorkOrderViewModel? = nil) {
        self.conversationId = conversationId
        self.customer = customer
        _vm = StateObject(wrappedValue: vm ?? NewWorkOrderViewModel(conversationId: conversationId, customer: customer))
    }

    var body: some View {
        Group {
            if vm.mode == .legacy || vm.legacyChosen {
                NewServiceOrderView(conversationId: conversationId, customer: customer)
            } else {
                form
            }
        }
        .task { await vm.start() }
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                switch vm.mode {
                case .loading:
                    SkeletonList(rows: 4, avatar: false)
                case .failed(let message):
                    InlineError(text: message)
                default:
                    typePicker
                    if let type = vm.type {
                        customerStep
                        if vm.needsObject { objectStep }
                        if !vm.fields.isEmpty {
                            Text("Dados da ordem").font(Theme.font(13, .semibold)).foregroundStyle(Theme.textSecondary)
                            WorkFieldsEditor(fields: vm.fields, draft: $vm.fieldDraft, required: vm.requiredFields)
                        }
                        AuthField(label: type.itemLabel + " *") { TextField(type.itemLabel, text: $vm.item).accessibilityIdentifier("wo.new.item") }
                        AuthField(label: type.problemLabel + " *") {
                            AppMultilineField(type.problemLabel, text: $vm.problem, lines: 2...6).padding(.vertical, 10).accessibilityIdentifier("wo.new.problem")
                        }
                        AuthField(label: "Observação interna (opcional)") { TextField("Não vai para o cliente", text: $vm.notes) }
                        if let notice = vm.notice { InlineError(text: notice).onTapGesture { vm.notice = nil } }
                        PrimaryButton(title: "Abrir ordem", icon: "wrench.and.screwdriver.fill", busy: vm.busy) { Task { await vm.submit() } }
                            .accessibilityIdentifier("wo.new.submit")
                        Text(conversationId != nil ? "O cliente recebe o número da ordem no WhatsApp." : "Sem conversa ligada, os avisos ao cliente dependem de ele falar com a empresa pelo WhatsApp.")
                            .font(Theme.font(12)).foregroundStyle(Theme.textSecondary)
                    } else {
                        Text("Escolha o modelo da ordem para continuar.").font(Theme.font(15)).foregroundStyle(Theme.textSecondary)
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(vm.type?.singular ?? "Nova ordem de serviço")
        .navigationBarTitleDisplayMode(.inline)
        .appNavigationBarHidden(false)
        .onChange(of: vm.created) { order in
            guard let order else { return }
            Workspace.shared.show("Ordem \(order.numberText) aberta", style: .success)
            dismiss()
            // iOS 16+: abre a ficha da ordem nova (no iOS 15 a lista mostra a ordem ao voltar).
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 450_000_000)
                push(.serviceOrder(id: order.id))
            }
        }
    }

    @ViewBuilder
    private var typePicker: some View {
        let types = vm.types
        if types.count > 1 {
            VStack(alignment: .leading, spacing: 6) {
                Text("Modelo").font(Theme.font(13, .semibold)).foregroundStyle(Theme.textSecondary)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(types.filter { !$0.isBuiltin }) { t in
                            FilterChip(title: t.singular, selected: vm.typeId == t.id) { vm.choose(t.id) }
                                .accessibilityIdentifier("wo.new.type.\(t.id)")
                        }
                        ForEach(types.filter(\.isBuiltin)) { t in
                            FilterChip(title: "Ordem de serviço (simples)", selected: false) { vm.choose(t.id) }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var customerStep: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Cliente").font(Theme.font(13, .semibold)).foregroundStyle(Theme.textSecondary)
            if let contact = vm.contact {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(contact.displayName).font(Theme.font(16, .semibold)).foregroundStyle(Theme.textPrimary)
                        if let phone = PhoneText.display(contact.phone) { Text(phone).font(Theme.font(13)).foregroundStyle(Theme.textSecondary) }
                    }
                    Spacer()
                    if conversationId == nil { Button("Trocar") { vm.pick(nil) }.font(Theme.font(15, .semibold)).foregroundStyle(Theme.brand) }
                }
                .card(padding: 14)
            } else {
                if conversationId != nil {
                    Text("Cliente da conversa: \(customer ?? "cliente").").font(Theme.font(15)).foregroundStyle(Theme.textPrimary)
                }
                if conversationId == nil || vm.needsObject {
                    if conversationId != nil {
                        Text("Para escolher o objeto do serviço, busque o cadastro deste cliente.").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                    }
                    SearchField(placeholder: "Nome ou telefone do cliente", text: Binding(get: { vm.contactQuery }, set: { vm.searchContacts($0) }), focused: $searching)
                        .accessibilityIdentifier("wo.new.customer")
                    if vm.searching {
                        ProgressView()
                    } else if vm.searched && vm.contacts.isEmpty {
                        Text(WorkOrderRules.noCustomer).font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
                    } else {
                        ForEach(vm.contacts) { found in
                            Button { vm.pick(found) } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(found.displayName).font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
                                    if let phone = PhoneText.display(found.phone) { Text(phone).font(Theme.font(13)).foregroundStyle(Theme.textSecondary) }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .card(padding: 12)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("wo.new.contact.\(found.id)")
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var objectStep: some View {
        let title = vm.objectType?.singular ?? "Objeto do serviço"
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(Theme.font(13, .semibold)).foregroundStyle(Theme.textSecondary)
            if vm.contact == nil {
                Text("Escolha o cliente para ver os cadastros de \(title.lowercased()).").font(Theme.font(13)).foregroundStyle(Theme.textSecondary)
            } else if vm.loadingObjects {
                ProgressView()
            } else {
                ForEach(vm.objects) { object in
                    let selected = vm.objectId == object.id && !vm.newObject
                    Button {
                        vm.objectId = object.id
                        vm.newObject = false
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(object.identifier?.isEmpty == false ? object.identifier! : title).font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
                            let details = objectDetails(object)
                            if !details.isEmpty { Text(details).font(Theme.font(13)).foregroundStyle(Theme.textSecondary) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(selected ? Theme.brand.opacity(0.14) : Theme.surface))
                        .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).stroke(selected ? Theme.brand : Color.clear, lineWidth: 1.5))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("wo.new.object.\(object.id)")
                }
                if vm.newObject {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Novo cadastro de \(title.lowercased())").font(Theme.font(15, .semibold)).foregroundStyle(Theme.textPrimary)
                        WorkFieldsEditor(fields: vm.objectFields, draft: $vm.objectDraft)
                    }
                    .card(padding: 14)
                } else {
                    Button(vm.objects.isEmpty ? "Cadastrar \(title.lowercased())" : "Cadastrar outro") {
                        vm.objectId = nil
                        vm.newObject = true
                    }
                    .font(Theme.font(15, .semibold)).foregroundStyle(Theme.brand)
                    .accessibilityIdentifier("wo.new.object.new")
                }
            }
        }
    }

    private func objectDetails(_ object: ServiceObjectView) -> String {
        let type = object.type ?? vm.objectType
        return WorkFields.visible(type?.fields)
            .filter { $0.id != type?.identifierFieldId }
            .map { ($0.title, WorkFields.display($0, object.values?[$0.id])) }
            .filter { $0.1 != "—" }
            .map { "\($0.0): \($0.1)" }
            .joined(separator: " · ")
    }
}
