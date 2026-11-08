import SwiftUI

struct LinesView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var lines: [ServiceLine] = []
    @State private var bots: [Bot] = []
    @State private var error: String?
    @State private var loading = true
    var body: some View {
        List {
            Section { Text("Escolha quem atende cada linha e quando os menus podem aparecer. A participação no roteador é independente.").font(.footnote).foregroundStyle(.secondary) }
            if loading { ProgressView() }
            if let error { Text(error).foregroundStyle(.red); Button("Tentar novamente") { Task { await load() } } }
            ForEach(lines) { line in
                NavigationLink { LineEditor(line: line, bots: bots) { Task { await load() } } } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(line.name).font(.headline)
                        Text([line.number, line.status == "active" ? "Ativa" : "Pausada", line.number_policy["pool"]?.boolValue == true ? "No roteador" : "Fora do roteador"].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if !loading && lines.isEmpty && error == nil { Text("Nenhuma linha cadastrada.") }
        }
        .navigationTitle("Linhas de atendimento")
        .task { await load() }.refreshable { await load() }
    }
    private func load() async {
        guard let p = container.profileId else { return }
        do { lines = try await container.api.lines(p); bots = try await container.api.bots(p).data; error = nil }
        catch { self.error = container.serviceError(error) }
        loading = false
    }
}

private struct LineEditor: View {
    let line: ServiceLine
    let bots: [Bot]
    var onSaved: () -> Void
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    @State private var mode: String
    @State private var botId: String
    @State private var menuMode: String
    @State private var policy: [String: JSONValue]
    @State private var error: String?
    @State private var busy = false
    @State private var pending: (body: [String: JSONValue], key: String)?
    init(line: ServiceLine, bots: [Bot], onSaved: @escaping () -> Void) {
        self.line = line; self.bots = bots; self.onSaved = onSaved
        _mode = State(initialValue: line.service.mode); _botId = State(initialValue: line.service.bot_id ?? "")
        _menuMode = State(initialValue: line.service.menu_mode); _policy = State(initialValue: line.number_policy)
    }
    var body: some View {
        Form {
            Section("Atendimento") {
                Picker("Responsável inicial", selection: $mode) {
                    Text("Configuração do perfil").tag("inherit"); Text("Equipe humana").tag("human"); Text("Bot específico").tag("bot")
                }
                if mode == "bot" {
                    Picker("Bot", selection: $botId) { Text("Selecione").tag(""); ForEach(bots.filter { $0.enabled == 1 && ($0.line_ids == nil || $0.line_ids == "null" || JSONValue.parseStringList($0.line_ids).contains(line.id)) }) { Text($0.name).tag($0.id) } }
                }
                Picker("Menus", selection: $menuMode) {
                    Text("Automáticos e sob demanda").tag("automatic"); Text("Apenas sob demanda").tag("manual"); Text("Desativados").tag("off")
                }
            }
            Section("Permissões da linha") {
                policyToggle("Participar do roteador", "pool")
                policyToggle("Atendimento por pessoas", "human")
                policyToggle("Atendimento por bots", "bots")
                policyToggle("Permitir menus", "menu")
                policyToggle("Integrações por API", "api")
                policyToggle("Mensagens de serviço", "service")
                policyToggle("Templates", "templates")
            }
            Section { Text("Conversas iniciadas continuam no mesmo número. O fim da franquia permite serviço pago; a janela de 24 horas continua obrigatória.").font(.footnote) }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .disabled(busy || container.user?.isAdmin != true)
        .navigationTitle(line.name)
        .toolbar { if container.user?.isAdmin == true { ToolbarItem(placement: .confirmationAction) { Button(busy ? "Salvando…" : "Salvar") { Task { await save() } }.disabled(busy || (mode == "bot" && botId.isEmpty)) } } }
    }
    private func policyToggle(_ label: String, _ key: String) -> some View {
        Toggle(label, isOn: Binding(get: { policy[key]?.boolValue ?? true }, set: { policy[key] = .bool($0) }))
    }
    private func save() async {
        guard let p = container.profileId else { return }
        var nextPolicy = policy; nextPolicy["purpose"] = .string("custom")
        let body: [String: JSONValue] = ["service": .object(["mode": .string(mode), "bot_id": botId.isEmpty ? .null : .string(botId), "menu_mode": .string(menuMode)]), "number_policy": .object(nextPolicy)]
        let key = pending?.body == body ? pending!.key : APIClient.newIdempotencyKey()
        pending = (body, key); busy = true
        defer { busy = false }
        do { _ = try await container.api.saveLine(p, id: line.id, body: body, key: key); pending = nil; onSaved(); dismiss() }
        catch { self.error = container.serviceError(error); if (error as? APIError)?.isDefinitiveWriteRejection == true { pending = nil } }
    }
}

struct BotLinesView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var bots: [Bot] = []
    @State private var lines: [ServiceLine] = []
    @State private var error: String?
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            ForEach(bots) { bot in
                NavigationLink { BotLineEditor(bot: bot, lines: lines) { Task { await load() } } } label: { Label(bot.name, systemImage: "cpu") }
            }
        }.navigationTitle("Linhas dos bots").task { await load() }.refreshable { await load() }
    }
    private func load() async {
        guard let p = container.profileId else { return }
        do { bots = try await container.api.bots(p).data; lines = try await container.api.lines(p); error = nil } catch { self.error = container.serviceError(error) }
    }
}

private struct BotLineEditor: View {
    let bot: Bot
    let lines: [ServiceLine]
    var onSaved: () -> Void
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    @State private var allLines: Bool
    @State private var selected: Set<String>
    @State private var busy = false
    @State private var error: String?
    @State private var key = APIClient.newIdempotencyKey()
    init(bot: Bot, lines: [ServiceLine], onSaved: @escaping () -> Void) {
        self.bot = bot; self.lines = lines; self.onSaved = onSaved
        _allLines = State(initialValue: bot.line_ids == nil || bot.line_ids == "null")
        _selected = State(initialValue: Set(JSONValue.parseStringList(bot.line_ids)))
    }
    var body: some View {
        Form {
            Toggle("Todas as linhas", isOn: $allLines)
            if !allLines {
                Section("Linhas autorizadas") { ForEach(lines) { line in Toggle(line.name, isOn: Binding(get: { selected.contains(line.id) }, set: { if $0 { selected.insert(line.id) } else { selected.remove(line.id) } })) } }
                Text("Sem linhas selecionadas, o bot fica disponível apenas para conversas internas.").font(.footnote)
            }
            if let error { Text(error).foregroundStyle(.red) }
        }.disabled(busy)
        .navigationTitle(bot.name)
        .onChange(of: allLines) { _ in key = APIClient.newIdempotencyKey() }
        .onChange(of: selected) { _ in key = APIClient.newIdempotencyKey() }
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Salvar") { Task { await save() } }.disabled(busy) } }
    }
    private func save() async {
        guard let p = container.profileId else { return }; busy = true; defer { busy = false }
        do { _ = try await container.api.assignBotLines(p, id: bot.id, lines: allLines ? nil : selected.sorted(), key: key); onSaved(); dismiss() } catch { self.error = container.serviceError(error); if (error as? APIError)?.isDefinitiveWriteRejection == true { key = APIClient.newIdempotencyKey() } }
    }
}
