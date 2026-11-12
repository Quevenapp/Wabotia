import SwiftUI

struct MenusView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var menus: [JSONValue] = []
    @State private var lines: [ServiceLine] = []
    @State private var bots: [Bot] = []
    @State private var apps: [JSONValue] = []
    @State private var error: String?
    @State private var editing: MenuDraft?
    var body: some View {
        List {
            Section { Text("Defina opções, submenus e as linhas em que aparecem. O submenu também respeita as linhas permitidas pelo menu pai.").font(.footnote).foregroundStyle(Theme.textSecondary) }
            if let error { Text(error).foregroundStyle(Theme.danger); Button("Tentar novamente") { Task { await load() } } }
            ForEach(menus, id: \.serviceId) { menu in
                Button { editing = MenuDraft(value: menu) } label: {
                    VStack(alignment: .leading) {
                        Text(menu["label"]?.stringValue ?? "Opção").foregroundStyle(Theme.textPrimary)
                        Text("\(MenuItems.typeLabel(menu["type"]?.stringValue)) · \(menu["parent_id"]?.stringValue.flatMap { parent in menus.first { $0.serviceId == parent }?["label"]?.stringValue } ?? "Menu principal") · \(menu["trigger"]?.stringValue == "manual" ? "Sob demanda" : "Automático")\(menu["enabled"]?.boolValue == false ? " · Desativado" : "")").font(.caption).foregroundStyle(Theme.textSecondary)
                    }
                }
            }
            if menus.isEmpty && error == nil { Text("Nenhuma opção cadastrada.") }
        }
        .navigationTitle("Menus e submenus").navigationBarTitleDisplayMode(.inline).appNavigationBarHidden(false)
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { editing = MenuDraft(value: .object(["id": .string(UUID().uuidString.lowercased()), "label": .string(""), "type": .string("human"), "enabled": .bool(true), "trigger": .string("automatic"), "line_ids": .array([])]), isNew: true) } label: { Image(systemName: "plus") }.accessibilityLabel("Criar opção") } }
        .sheet(item: $editing) { draft in AppNavigationStack { MenuEditor(draft: draft, menus: menus, lines: lines, bots: bots, apps: apps) { Task { await load() } } } }
        .task { await load() }.refreshable { await load() }
    }
    private func load() async {
        guard let p = container.profileId else { return }
        do { menus = try await container.api.menus(p); lines = try await container.api.lines(p); bots = try await container.api.bots(p).data; apps = try await container.api.profileStatus(p).settings?["apps"]?.arrayValue ?? []; error = nil }
        catch { self.error = container.serviceError(error) }
    }
}

extension JSONValue { var serviceId: String { self["id"]?.stringValue ?? "" } }

/// Destinos de uma opção de menu (`type`). `ticket` ("Abrir protocolo") chegou no servidor 0.14.
enum MenuItems {
    /// Destinos que o aplicativo sabe montar.
    static let editableTypes = ["human", "bot", "submenu", "app", "ticket"]

    /// Nome legível do destino; um tipo que este aplicativo ainda não conhece aparece com o próprio identificador,
    /// nunca como outro destino.
    static func typeLabel(_ type: String?) -> String {
        switch type ?? "" {
        case "", "human": return "Pessoa"
        case "bot": return "Bot"
        case "submenu": return "Submenu"
        case "app": return "Aplicativo"
        case "link": return "Link"
        case "content": return "Mensagem informativa"
        case "protocols": return "Consultar protocolos"
        case "survey": return "Pesquisa de satisfação"
        case "ticket": return "Abrir protocolo"
        default: return "Outro destino (\(type ?? ""))"
        }
    }

    /// Destinos oferecidos no editor: os que o aplicativo monta, mais o destino atual da opção quando for outro
    /// (link, mensagem, consulta, pesquisa ou um tipo mais novo), que assim continua selecionado.
    static func choices(original: String) -> [String] {
        editableTypes.contains(original) ? editableTypes : editableTypes + [original]
    }

    /// Item depois da edição. Parte do item original e só troca o que a tela edita: campos de destinos que o aplicativo
    /// não edita (`url`, `content`, `question`, `department_id`…) e de tipos mais novos seguem intactos. `bot_id`/`app_id`
    /// só mudam quando o destino é bot/aplicativo; `category_id` só quando o destino é `ticket` (vazio remove o campo).
    static func edited(_ original: JSONValue, label: String, type: String, parentId: String, botId: String, appId: String, categoryId: String, trigger: String, enabled: Bool, lineIds: [String]) -> JSONValue {
        var item = original.objectValue ?? [:]
        item["label"] = .string(label.trimmingCharacters(in: .whitespaces))
        item["type"] = .string(type)
        item["parent_id"] = parentId.isEmpty ? .null : .string(parentId)
        if type == "bot" { item["bot_id"] = .string(botId) }
        if type == "app" { item["app_id"] = .string(appId) }
        if type == "ticket" {
            if categoryId.isEmpty { item.removeValue(forKey: "category_id") } else { item["category_id"] = JSONValue.string(categoryId) }
        }
        item["trigger"] = .string(trigger)
        item["enabled"] = .bool(enabled)
        item["line_ids"] = .array(lineIds.map(JSONValue.string))
        return .object(item)
    }
}
private struct MenuDraft: Identifiable { var value: JSONValue; var isNew = false; var id: String { value.serviceId } }

private struct MenuEditor: View {
    let draft: MenuDraft
    let menus: [JSONValue]
    let lines: [ServiceLine]
    let bots: [Bot]
    let apps: [JSONValue]
    let onSaved: () -> Void
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    @State private var label: String
    @State private var type: String
    @State private var parent: String
    @State private var bot: String
    @State private var app: String
    /// Destino "Abrir protocolo": categoria opcional do protocolo que o cliente abre.
    @State private var category: String
    @ObservedObject private var workspace = Workspace.shared
    private var originalType: String { draft.value["type"]?.stringValue ?? "human" }
    private var categoryOptions: [TicketCategory] {
        var list = workspace.ticketCategories.filter { $0.enabled || $0.id == category }
        if !category.isEmpty, !list.contains(where: { $0.id == category }) { list.append(TicketCategory(id: category, name: category, enabled: false)) }
        return list
    }
    @State private var trigger: String
    @State private var enabled: Bool
    @State private var selected: Set<String>
    @State private var allLines: Bool
    @State private var busy = false
    @State private var error: String?
    @State private var pending: (menus: [JSONValue], key: String)?
    init(draft: MenuDraft, menus: [JSONValue], lines: [ServiceLine], bots: [Bot], apps: [JSONValue], onSaved: @escaping () -> Void) {
        self.draft = draft; self.menus = menus; self.lines = lines; self.bots = bots; self.apps = apps; self.onSaved = onSaved
        let m = draft.value
        _label = State(initialValue: m["label"]?.stringValue ?? ""); _type = State(initialValue: m["type"]?.stringValue ?? "human")
        _parent = State(initialValue: m["parent_id"]?.stringValue ?? ""); _bot = State(initialValue: m["bot_id"]?.stringValue ?? ""); _app = State(initialValue: m["app_id"]?.stringValue ?? "")
        _category = State(initialValue: m["category_id"]?.stringValue ?? "")
        _trigger = State(initialValue: m["trigger"]?.stringValue ?? "automatic"); _enabled = State(initialValue: m["enabled"]?.boolValue ?? true)
        let ids = m["line_ids"]?.arrayValue?.compactMap { $0.stringValue } ?? []
        _selected = State(initialValue: Set(ids)); _allLines = State(initialValue: ids.isEmpty)
    }
    var body: some View {
        Form {
            Section("Opção") {
                TextField("Texto da opção", text: $label)
                Toggle("Habilitada", isOn: $enabled)
                Picker("Menu pai", selection: $parent) {
                    Text("Menu principal").tag("")
                    ForEach(menus.filter { $0.serviceId != draft.id && $0["type"]?.stringValue == "submenu" }, id: \.serviceId) { Text($0["label"]?.stringValue ?? "Submenu").tag($0.serviceId) }
                }
                Picker("Destino", selection: $type) { ForEach(MenuItems.choices(original: originalType), id: \.self) { Text(MenuItems.typeLabel($0)).tag($0) } }
                if type == "ticket", !categoryOptions.isEmpty {
                    Picker("Categoria do protocolo", selection: $category) { Text("Sem categoria").tag(""); ForEach(categoryOptions) { Text($0.name).tag($0.id) } }
                }
                if type == "bot" { Picker("Bot", selection: $bot) { Text("Selecione").tag(""); ForEach(bots) { Text($0.name).tag($0.id) } } }
                if type == "app" { Picker("Aplicativo", selection: $app) { Text("Selecione").tag(""); ForEach(apps, id: \.serviceId) { Text($0["name"]?.stringValue ?? "Aplicativo").tag($0.serviceId) } } }
                Picker("Disponibilidade", selection: $trigger) { Text("Automática").tag("automatic"); Text("Quando pessoa ou bot chamar").tag("manual") }
            }
            if type == "ticket" {
                Section { Text("O cliente descreve o que precisa em uma mensagem e recebe o número do protocolo. A conversa não vai para a fila humana.").font(.footnote).foregroundStyle(Theme.textSecondary) }
            } else if type == originalType, !["human", "bot", "submenu", "app"].contains(type) {
                Section { Text("Os detalhes deste destino (\(MenuItems.typeLabel(type))) são editados no painel web; aqui você ajusta texto, menu pai, disponibilidade e linhas.").font(.footnote).foregroundStyle(Theme.textSecondary) }
            }
            Section("Linhas") {
                Toggle("Todas as linhas permitidas", isOn: $allLines)
                if !allLines { ForEach(lines) { line in Toggle(line.name, isOn: Binding(get: { selected.contains(line.id) }, set: { if $0 { selected.insert(line.id) } else { selected.remove(line.id) } })) } }
            }
            if let error { Text(error).foregroundStyle(Theme.danger) }
        }.disabled(busy)
        .navigationTitle(draft.isNew ? "Criar opção" : "Editar opção")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) { Button("Salvar") { Task { await save() } }.disabled(busy || label.trimmingCharacters(in: .whitespaces).isEmpty || (!allLines && selected.isEmpty) || (type == "bot" && bot.isEmpty) || (type == "app" && app.isEmpty)) }
        }
    }
    private func save() async {
        guard let p = container.profileId else { return }; busy = true; defer { busy = false }
        do {
            let item = MenuItems.edited(draft.value, label: label, type: type, parentId: parent, botId: bot, appId: app, categoryId: category, trigger: trigger, enabled: enabled, lineIds: allLines ? [] : selected.sorted())
            let latest = try await container.api.menus(p)
            // Preserve other administrators' changes to unrelated menu items.
            let current = latest.first { $0.serviceId == draft.id }
            if !draft.isNew && current != draft.value && current != item { error = "Esta opção foi alterada em outro dispositivo. Feche e abra novamente antes de salvar."; return }
            var next = latest.filter { $0.serviceId != draft.id }
            if let index = latest.firstIndex(where: { $0.serviceId == draft.id }) { next.insert(item, at: min(index, next.count)) } else { next.append(item) }
            let key = pending?.menus == next ? pending!.key : APIClient.newIdempotencyKey(); pending = (next, key)
            _ = try await container.api.saveMenus(p, menus: next, key: key); pending = nil; onSaved(); dismiss()
        } catch { self.error = container.serviceError(error); if (error as? APIError)?.isDefinitiveWriteRejection == true { pending = nil } }
    }
}
