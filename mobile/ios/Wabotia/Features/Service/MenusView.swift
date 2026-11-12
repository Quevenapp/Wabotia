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
                        Text("\(menu["parent_id"]?.stringValue.flatMap { parent in menus.first { $0.serviceId == parent }?["label"]?.stringValue } ?? "Menu principal") · \(menu["trigger"]?.stringValue == "manual" ? "Sob demanda" : "Automático")\(menu["enabled"]?.boolValue == false ? " · Desativado" : "")").font(.caption).foregroundStyle(Theme.textSecondary)
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
                Picker("Destino", selection: $type) { Text("Pessoa").tag("human"); Text("Bot").tag("bot"); Text("Submenu").tag("submenu"); Text("Aplicativo").tag("app") }
                if type == "bot" { Picker("Bot", selection: $bot) { Text("Selecione").tag(""); ForEach(bots) { Text($0.name).tag($0.id) } } }
                if type == "app" { Picker("Aplicativo", selection: $app) { Text("Selecione").tag(""); ForEach(apps, id: \.serviceId) { Text($0["name"]?.stringValue ?? "Aplicativo").tag($0.serviceId) } } }
                Picker("Disponibilidade", selection: $trigger) { Text("Automática").tag("automatic"); Text("Quando pessoa ou bot chamar").tag("manual") }
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
            var item = draft.value.objectValue ?? [:]
            item.merge(["label": .string(label.trimmingCharacters(in: .whitespaces)), "type": .string(type), "parent_id": parent.isEmpty ? .null : .string(parent), "bot_id": .string(bot), "app_id": .string(app), "trigger": .string(trigger), "enabled": .bool(enabled), "line_ids": .array((allLines ? [] : selected.sorted()).map(JSONValue.string))]) { _, new in new }
            let latest = try await container.api.menus(p)
            // Preserve other administrators' changes to unrelated menu items.
            let current = latest.first { $0.serviceId == draft.id }
            if !draft.isNew && current != draft.value && current != .object(item) { error = "Esta opção foi alterada em outro dispositivo. Feche e abra novamente antes de salvar."; return }
            var next = latest.filter { $0.serviceId != draft.id }
            if let index = latest.firstIndex(where: { $0.serviceId == draft.id }) { next.insert(.object(item), at: min(index, next.count)) } else { next.append(.object(item)) }
            let key = pending?.menus == next ? pending!.key : APIClient.newIdempotencyKey(); pending = (next, key)
            _ = try await container.api.saveMenus(p, menus: next, key: key); pending = nil; onSaved(); dismiss()
        } catch { self.error = container.serviceError(error); if (error as? APIError)?.isDefinitiveWriteRejection == true { pending = nil } }
    }
}
