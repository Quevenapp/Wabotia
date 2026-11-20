import React from "react";
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NATIVE_MANAGEMENT_ITEMS } from "../src/modules/panel-navigation";
import { sections } from "../web/workspace-navigation";
import { ManagementPage, lazyWithRecovery } from "../web/management/pages";
import adminSource from "../web/admin/AdminArea.tsx?raw";
import conversationSource from "../web/modules/pedido/ConversationPedido.tsx?raw";
import pagesSource from "../web/management/pages.tsx?raw";

const runtime = vi.hoisted(() => ({
  imported: [] as string[],
  owner: null as any,
}));
// Os imports reais são interceptados na fronteira da página: nenhuma API nem página irmã é carregada.
vi.mock("../web/modules/os/work/WorkListPage", () => {
  runtime.imported.push("work");
  return { WorkPage: () => "work" };
});
vi.mock("../web/modules/os/tasks/MyDeadlinesPage", () => {
  runtime.imported.push("my-deadlines");
  return { MyDeadlinesPage: () => "my-deadlines" };
});
vi.mock("../web/modules/os/WorkSettingsPage", () => {
  runtime.imported.push("work-types");
  return { WorkSettingsPage: () => "work-types" };
});
vi.mock("../web/modules/agenda/AgendaPage", () => {
  runtime.imported.push("agenda");
  return { AgendaPage: () => "agenda" };
});
vi.mock("../web/modules/agenda/AgendaSettingsPage", () => {
  runtime.imported.push("agenda-settings");
  return { AgendaSettingsPage: () => "agenda-settings" };
});
vi.mock("../web/modules/mensalidade/MensalidadesPage", () => {
  runtime.imported.push("mensalidades");
  return { MensalidadesPage: () => "mensalidades" };
});
vi.mock("../web/modules/mensalidade/MensalidadeSettingsPage", () => {
  runtime.imported.push("mensalidade-settings");
  return { MensalidadeSettingsPage: () => "mensalidade-settings" };
});
vi.mock("../web/modules/pedido/OrdersPage", () => {
  runtime.imported.push("pedidos");
  return { OrdersPage: () => "pedidos" };
});
vi.mock("../web/modules/pedido/MenuPage", () => {
  runtime.imported.push("pedidos-cardapio");
  return { MenuPage: () => "pedidos-cardapio" };
});
vi.mock("../web/modules/mesas/MesasPage", () => {
  runtime.imported.push("mesas");
  return { MesasPage: () => "mesas" };
});
vi.mock("../web/modules/reserva/ReservaPage", () => {
  runtime.imported.push("reserva");
  return { ReservaPage: () => "reserva" };
});
vi.mock("../web/modules/reserva/ReservaSettingsPage", () => {
  runtime.imported.push("reserva-settings");
  return { ReservaSettingsPage: () => "reserva-settings" };
});
vi.mock("../web/modules/suporte/SuportePage", () => {
  runtime.imported.push("suporte");
  return { SuportePage: () => "suporte" };
});
vi.mock("../web/modules/suporte/SuporteSettingsPage", () => {
  runtime.imported.push("suporte-settings");
  return { SuporteSettingsPage: () => "suporte-settings" };
});
vi.mock("../web/modules/condominio/CondominioPage", () => {
  runtime.imported.push("condominio");
  return { CondominioPage: () => "condominio" };
});
vi.mock("../web/modules/juridico/PrazosPage", () => {
  runtime.imported.push("juridico");
  return { PrazosPage: () => "juridico" };
});
vi.mock("../web/modules/saude/SaudePage", () => {
  runtime.imported.push("saude");
  return { SaudePage: () => "saude" };
});
vi.mock("../web/modules/ensino/EnsinoPage", () => {
  runtime.imported.push("ensino");
  return { EnsinoPage: () => "ensino" };
});
vi.mock("../web/admin/FormsPage", () => {
  runtime.imported.push("forms");
  return { FormsPage: () => "forms" };
});
vi.mock("../web/admin/PaymentsPage", () => {
  runtime.imported.push("payments");
  return { PaymentsPage: () => "payments" };
});

// Só a prova do botão de repetição controla hooks; a renderização lazy usa React/Suspense reais.
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: any) => {
      if (!runtime.owner) return actual.useState(initial);
      const owner = runtime.owner,
        index = owner.index++;
      if (!(index in owner.slots))
        owner.slots[index] =
          typeof initial === "function" ? initial() : initial;
      return [
        owner.slots[index],
        (value: any) => {
          owner.slots[index] =
            typeof value === "function" ? value(owner.slots[index]) : value;
        },
      ];
    },
    useMemo: (compute: () => any, deps: any[]) => {
      if (!runtime.owner) return actual.useMemo(compute, deps);
      const owner = runtime.owner,
        index = owner.index++,
        old = owner.slots[index];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i])))
        owner.slots[index] = { deps, value: compute() };
      return owner.slots[index].value;
    },
  };
});

async function markup(
  element: React.ReactElement,
  onError?: (error: unknown) => void,
) {
  const stream = await renderToReadableStream(element, { onError });
  // Consome desde o fallback, para não bloquear o buffer enquanto o import termina.
  const text = new Response(stream).text();
  await stream.allReady;
  return text;
}
const imports = (source: string) =>
  [
    ...source.matchAll(/^import\s+(?!type\b)[\s\S]*?from\s*["']([^"']+)["']/gm),
  ].map((match) => match[1]);

describe("páginas nativas sob demanda", () => {
  it("cobre a lista permitida sem importar páginas; baixa somente a página renderizada", async () => {
    const allowed = Object.values(NATIVE_MANAGEMENT_ITEMS)
      .flat()
      .map((item) => item.target.page);
    expect(runtime.imported).toEqual([]);
    for (const [page] of sections) {
      const element = ManagementPage({ page });
      if (
        allowed.includes(page as (typeof allowed)[number]) ||
        // service-objects: rota interna da parte 2, sem item lateral próprio.
        ["service-orders", "service-orders-settings", "my-deadlines", "service-objects"].includes(page)
      )
        expect(element.props).not.toHaveProperty("title");
      else
        expect(element.props).toHaveProperty("title", "Página não encontrada");
    }
    expect(runtime.imported).toEqual([]);
    const loaded: string[] = [];
    for (const page of allowed) {
      expect(
        await markup(React.createElement(ManagementPage, { page })),
      ).toContain(page);
      loaded.push(page);
      expect(runtime.imported).toEqual(loaded);
    }
    expect(
      await markup(
        React.createElement(ManagementPage, { page: "service-orders" }),
      ),
    ).toContain("work");
    expect(runtime.imported).toEqual(loaded);
    expect(ManagementPage({ page: "work" }).type).toBe(
      ManagementPage({ page: "service-orders" }).type,
    );
    expect(ManagementPage({ page: "work-types" }).type).toBe(
      ManagementPage({ page: "service-orders-settings" }).type,
    );
    expect(await markup(React.createElement(ManagementPage, { page: "service-orders-settings" }))).toContain("work-types");
    expect(runtime.imported).toEqual(loaded);
    expect(await markup(React.createElement(ManagementPage, { page: "my-deadlines" }))).toContain("my-deadlines");
    expect(runtime.imported).toEqual([...loaded, "my-deadlines"]);
  });

  it("mostra fallback enquanto o arquivo não chega", async () => {
    let finish!: (value: { default: React.ComponentType }) => void;
    const load = vi.fn(
      () =>
        new Promise<{ default: React.ComponentType }>((resolve) => {
          finish = resolve;
        }),
    );
    const Deferred = lazyWithRecovery<object>(load);
    const Loaded = vi.fn(() => React.createElement("p", null, "Pronto"));
    // React 19 retém o primeiro bloco quando Suspense ocupa toda a raiz.
    // A estrutura externa permite observar o fallback com o import ainda pendente.
    const stream = await renderToReadableStream(
      React.createElement("main", null, React.createElement(Deferred)),
    );
    const reader = stream.getReader();
    const first = await reader.read();
    const pending = new TextDecoder().decode(first.value);
    expect(first.done).toBe(false);
    expect(pending).toContain('role="status"');
    expect(pending).toContain("Abrindo a página");
    expect(pending).not.toContain("Pronto");
    expect(load).toHaveBeenCalledOnce();
    expect(Loaded).not.toHaveBeenCalled();
    finish({ default: Loaded });
    let rest = "";
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      rest += new TextDecoder().decode(result.value);
    }
    expect(rest).toContain("Pronto");
    expect(load).toHaveBeenCalledOnce();
    expect(Loaded).toHaveBeenCalledOnce();
  });

  it("repete um import rejeitado sem repetir comandos e oferece recarga da versão", async () => {
    const action = vi.fn();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("arquivo indisponível"))
      .mockResolvedValue({
        default: ({ onSave }: { onSave(): void }) =>
          React.createElement("button", { onClick: onSave }, "Salvar"),
      });
    const Deferred = lazyWithRecovery<{ onSave(): void }>(load);
    const owner = { index: 0, slots: [] as any[] };
    const draw = () => {
      owner.index = 0;
      runtime.owner = owner;
      try {
        return Deferred({ onSave: action }) as React.ReactElement<any>;
      } finally {
        runtime.owner = null;
      }
    };
    const tree = draw();
    const errors: unknown[] = [];
    await markup(tree.props.children, (error) => {
      errors.push(error);
    });
    expect(load).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    const Boundary = tree.type as any;
    const boundary = new Boundary(tree.props);
    boundary.state = Boundary.getDerivedStateFromError(errors[0]);
    const failed = boundary.render();
    const buttons = React.Children.toArray(
      failed.props.action.props.children,
    ) as React.ReactElement<any>[];
    expect(buttons.map((button) => button.props.children)).toEqual([
      "Tentar novamente",
      "Recarregar",
    ]);
    buttons[0].props.onClick();
    const retry = draw();
    expect(retry.key).not.toBe(tree.key);
    expect(await markup(retry.props.children)).toContain("Salvar");
    expect(load).toHaveBeenCalledTimes(2);
    expect(action).not.toHaveBeenCalled();
    // Erro da página já montada não ganha botão que remonte e repita ações de negócio.
    boundary.state = Boundary.getDerivedStateFromError(
      new Error("erro de renderização"),
    );
    const contentError = boundary.render();
    expect(
      React.Children.toArray(contentError.props.action.props.children),
    ).toHaveLength(1);
  });

  it("AdminArea e conversa não importam páginas operacionais estaticamente", () => {
    expect(
      imports(adminSource).filter((path) =>
        /\/modules\/|FormsPage|PaymentsPage|work-navigation/.test(path),
      ),
    ).toEqual([]);
    expect(adminSource).not.toMatch(
      /useWorkNavigation|case "(?:work|agenda|pedidos|forms|payments)"/,
    );
    expect(adminSource).toContain("QueueSettingsPage");
    expect(adminSource).toContain("AreaTemplatesPage");
    expect(imports(conversationSource)).not.toContain("./OrdersPage");
    expect(conversationSource).toContain('import("./OrdersPage")');
    expect(conversationSource).toMatch(/openId && \(/);
    expect(conversationSource).toContain("onClose={() => setOpenId(null)}");
    expect(conversationSource).toContain("onChanged={() => void load()}");
    expect(conversationSource).toContain("retry: false");
    expect(
      imports(pagesSource).filter((path) =>
        /\/modules\/|\/erp\/|\/admin\//.test(path),
      ),
    ).toEqual([]);
    expect(pagesSource).not.toMatch(
      /import\(`|prefetch|preload|react-router-dom/,
    );
  });
});
