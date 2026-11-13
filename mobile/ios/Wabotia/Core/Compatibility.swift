import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// The iPhone 7 runs iOS 15. Keep equivalent controls on that system while
/// using the current navigation and presentation APIs on newer devices.
struct AppNavigationStack<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        if #available(iOS 16, *) { NavigationStack { content() } }
        else { NavigationView { content() }.navigationViewStyle(.stack) }
    }
}

struct AppLabeledContent: View {
    let title: String
    let value: String
    init(_ title: String, value: String) { self.title = title; self.value = value }
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).foregroundStyle(Theme.textPrimary)
            Spacer(minLength: 12)
            Text(value).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.trailing)
        }
    }
}

struct AppShareLink<Label: View>: View {
    let item: URL
    @ViewBuilder var label: () -> Label
    @State private var showing = false
    var body: some View {
        Button { showing = true } label: { label() }
            .sheet(isPresented: $showing) { ActivitySheet(item: item) }
    }
}

private struct ActivitySheet: UIViewControllerRepresentable {
    let item: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [item], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Campo de texto que cresce com o conteúdo, de `lines.lowerBound` a `lines.upperBound` linhas.
/// iOS 16+: `TextField(axis: .vertical)`. iOS 15: `TextEditor` dimensionado por um texto invisível,
/// para não ocupar a altura máxima quando está vazio (importante no iPhone 7 com o teclado aberto).
struct AppMultilineField: View {
    let placeholder: String
    @Binding var text: String
    let lines: ClosedRange<Int>
    var font: Font = .body
    init(_ placeholder: String, text: Binding<String>, lines: ClosedRange<Int>, font: Font = .body) {
        self.placeholder = placeholder; self._text = text; self.lines = lines; self.font = font
    }
    var body: some View {
        if #available(iOS 16, *) {
            TextField(placeholder, text: $text, axis: .vertical).lineLimit(lines).font(font)
        } else {
            LegacyGrowingEditor(placeholder: placeholder, text: $text, lines: lines, font: font)
        }
    }
}

private struct LegacyGrowingEditor: View {
    let placeholder: String
    @Binding var text: String
    let lines: ClosedRange<Int>
    let font: Font

    /// O que define a altura: o próprio texto (com uma linha a mais quando termina em quebra de linha).
    private var sizer: String {
        let minimum = String(repeating: "\n", count: max(0, lines.lowerBound - 1))
        if text.isEmpty { return " " + minimum }
        let body = text.hasSuffix("\n") ? text + " " : text
        let missing = max(0, lines.lowerBound - 1 - body.filter { $0 == "\n" }.count)
        return body + String(repeating: "\n", count: missing)
    }

    var body: some View {
        Text(sizer)
            .font(font)
            .lineLimit(lines.upperBound)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 5)
            .padding(.vertical, 8)
            .opacity(0)
            .overlay(TextEditor(text: $text).font(font))
            .overlay(alignment: .topLeading) {
                if text.isEmpty {
                    Text(placeholder).font(font).foregroundStyle(Theme.textSecondary)
                        .padding(.horizontal, 5).padding(.vertical, 8)
                        .allowsHitTesting(false)
                }
            }
            .accessibilityLabel(placeholder)
    }
}

extension View {
    @ViewBuilder func appNavigationPicker() -> some View {
        if #available(iOS 16, *) { pickerStyle(.navigationLink) }
        else { pickerStyle(.menu) }
    }
    @ViewBuilder func appNavigationDestination<Destination: View>(isPresented: Binding<Bool>, @ViewBuilder destination: @escaping () -> Destination) -> some View {
        if #available(iOS 16, *) { navigationDestination(isPresented: isPresented, destination: destination) }
        else { background(NavigationLink(destination: destination(), isActive: isPresented) { EmptyView() }.hidden()) }
    }
    /// Folha em meia altura (e alta ao arrastar), com cantos de 24 e puxador. Usa
    /// `UISheetPresentationController`, que existe desde o iOS 15; no iPad vira o cartão padrão do sistema.
    func appSheetDetents(medium: Bool = true) -> some View {
        background(SheetConfigurator(medium: medium))
    }
    @ViewBuilder func appScrollDismissesKeyboard() -> some View {
        if #available(iOS 16, *) { scrollDismissesKeyboard(.interactively) }
        else { self }
    }
    @ViewBuilder func appDarkNavigationBar() -> some View {
        if #available(iOS 16, *) { toolbarBackground(.visible, for: .navigationBar).toolbarColorScheme(.dark, for: .navigationBar) }
        else { self }
    }
    /// Esconde ou mostra a barra de navegação do sistema (telas com barra própria).
    @ViewBuilder func appNavigationBarHidden(_ hidden: Bool) -> some View {
        if #available(iOS 16, *) { toolbar(hidden ? .hidden : .visible, for: .navigationBar) }
        else { navigationBarHidden(hidden) }
    }
    /// Fundo próprio em `List`/`Form` (o fundo padrão do sistema sai de cena).
    @ViewBuilder func appListBackground(_ color: Color) -> some View {
        if #available(iOS 16, *) { scrollContentBackground(.hidden).background(color.ignoresSafeArea()) }
        else { background(color.ignoresSafeArea()) }
    }
    /// Fundo transparente no `TextEditor` (no iOS 15 isso vem de `UITextView.appearance`, em Theme).
    @ViewBuilder func appClearEditorBackground() -> some View {
        if #available(iOS 16, *) { scrollContentBackground(.hidden) }
        else { self }
    }
}

/// Ajusta a folha que contém esta vista: detentes, cantos e puxador.
private struct SheetConfigurator: UIViewControllerRepresentable {
    let medium: Bool

    func makeUIViewController(context: Context) -> Controller { Controller(medium: medium) }
    func updateUIViewController(_ controller: Controller, context: Context) { controller.apply() }

    final class Controller: UIViewController {
        let medium: Bool
        init(medium: Bool) {
            self.medium = medium
            super.init(nibName: nil, bundle: nil)
            view.isUserInteractionEnabled = false
            view.backgroundColor = .clear
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) não é usado") }

        override func willMove(toParent parent: UIViewController?) {
            super.willMove(toParent: parent)
            apply(parent)
        }
        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            apply()
        }

        func apply(_ start: UIViewController? = nil) {
            var controller = start ?? parent
            while let current = controller {
                if let sheet = current.sheetPresentationController {
                    sheet.detents = medium ? [.medium(), .large()] : [.large()]
                    sheet.prefersGrabberVisible = true
                    sheet.preferredCornerRadius = Theme.sheetRadius
                    sheet.prefersScrollingExpandsWhenScrolledToEdge = true
                    return
                }
                controller = current.parent
            }
        }
    }
}

/// Com a barra do sistema escondida, o gesto de voltar pela borda continua valendo.
/// `SwipeBack.disabled` bloqueia o gesto enquanto uma tela não puder ser abandonada.
enum SwipeBack {
    static var disabled = false
}

extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1 && !SwipeBack.disabled
    }
}

/// PHPicker preserves multiple photo/video selection on iOS 15 without broad
/// photo-library access. Files are loaded only after the user selects them.
struct PhotoLibraryPicker: UIViewControllerRepresentable {
    let limit: Int
    var selected: ([PHPickerResult]) -> Void
    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.selectionLimit = max(1, limit)
        configuration.filter = .any(of: [.images, .videos])
        let controller = PHPickerViewController(configuration: configuration)
        controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(selected) }
    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let selected: ([PHPickerResult]) -> Void
        init(_ selected: @escaping ([PHPickerResult]) -> Void) { self.selected = selected }
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) { selected(results) }
    }
}
