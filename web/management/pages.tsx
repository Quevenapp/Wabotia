import React, { lazy, Suspense, useMemo, useState } from "react";
import type { PageId } from "../workspace-navigation";
import { Button, Empty, Spinner } from "../ui";

class ChunkLoadError extends Error {}

class PageBoundary extends React.Component<
  { children: React.ReactNode; retry(): void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    const chunkFailed = this.state.error instanceof ChunkLoadError;
    return (
      <Empty
        title="Não foi possível abrir a página"
        description={
          chunkFailed
            ? "Confira a conexão e tente novamente. Se o painel foi atualizado, recarregue para buscar a versão nova."
            : "Recarregue o painel para abrir esta página novamente."
        }
        action={
          <>
            {chunkFailed && (
              <Button onClick={this.props.retry}>Tentar novamente</Button>
            )}
            <Button secondary onClick={() => location.reload()}>
              Recarregar
            </Button>
          </>
        }
      />
    );
  }
}

/** A repetição refaz somente o import que falhou antes da montagem, nunca uma ação de negócio. */
export function lazyWithRecovery<Props extends object>(
  load: () => Promise<{ default: React.ComponentType<Props> }>,
) {
  const loadChunk = () =>
    load().catch((cause: unknown) => {
      throw new ChunkLoadError("Falha ao carregar a página.", { cause });
    });
  const Initial = lazy(loadChunk);
  return function DeferredPage(props: Props) {
    const [attempt, setAttempt] = useState(0);
    const Component = useMemo(
      () => (attempt ? lazy(loadChunk) : Initial),
      [attempt],
    );
    return (
      <PageBoundary
        key={attempt}
        retry={() => setAttempt((value) => value + 1)}
      >
        <Suspense
          fallback={
            <div role="status">
              <Spinner label="Abrindo a página…" />
            </div>
          }
        >
          <Component {...props} />
        </Suspense>
      </PageBoundary>
    );
  };
}

// Importações explícitas: nenhuma página baixa ao importar este registro ou ao passar pelo menu.
const Work = lazyWithRecovery<object>(() =>
  import("../modules/os/work/WorkListPage").then((m) => ({
    default: m.WorkPage,
  })),
);
const WorkSettings = lazyWithRecovery<object>(() =>
  import("../modules/os/WorkSettingsPage").then((m) => ({ default: m.WorkSettingsPage })),
);
const pages = {
  work: Work,
  "service-objects": lazyWithRecovery(() =>
    import("../modules/os/os2-pages").then((m) => ({ default: m.Os2ObjectPage })),
  ),
  "service-orders": Work,
  "my-deadlines": lazyWithRecovery(() =>
    import("../modules/os/tasks/MyDeadlinesPage").then((m) => ({
      default: m.MyDeadlinesPage,
    })),
  ),
  "work-types": WorkSettings,
  "service-orders-settings": WorkSettings,
  agenda: lazyWithRecovery(() =>
    import("../modules/agenda/AgendaPage").then((m) => ({
      default: m.AgendaPage,
    })),
  ),
  "agenda-settings": lazyWithRecovery(() =>
    import("../modules/agenda/AgendaSettingsPage").then((m) => ({
      default: m.AgendaSettingsPage,
    })),
  ),
  mensalidades: lazyWithRecovery(() =>
    import("../modules/mensalidade/MensalidadesPage").then((m) => ({
      default: m.MensalidadesPage,
    })),
  ),
  "mensalidade-settings": lazyWithRecovery(() =>
    import("../modules/mensalidade/MensalidadeSettingsPage").then((m) => ({
      default: m.MensalidadeSettingsPage,
    })),
  ),
  pedidos: lazyWithRecovery(() =>
    import("../modules/pedido/OrdersPage").then((m) => ({
      default: m.OrdersPage,
    })),
  ),
  "pedidos-cardapio": lazyWithRecovery(() =>
    import("../modules/pedido/MenuPage").then((m) => ({ default: m.MenuPage })),
  ),
  mesas: lazyWithRecovery(() =>
    import("../modules/mesas/MesasPage").then((m) => ({
      default: m.MesasPage,
    })),
  ),
  reserva: lazyWithRecovery(() =>
    import("../modules/reserva/ReservaPage").then((m) => ({
      default: m.ReservaPage,
    })),
  ),
  "reserva-settings": lazyWithRecovery(() =>
    import("../modules/reserva/ReservaSettingsPage").then((m) => ({
      default: m.ReservaSettingsPage,
    })),
  ),
  suporte: lazyWithRecovery(() =>
    import("../modules/suporte/SuportePage").then((m) => ({
      default: m.SuportePage,
    })),
  ),
  "suporte-settings": lazyWithRecovery(() =>
    import("../modules/suporte/SuporteSettingsPage").then((m) => ({
      default: m.SuporteSettingsPage,
    })),
  ),
  condominio: lazyWithRecovery(() =>
    import("../modules/condominio/CondominioPage").then((m) => ({
      default: m.CondominioPage,
    })),
  ),
  juridico: lazyWithRecovery(() =>
    import("../modules/juridico/PrazosPage").then((m) => ({
      default: m.PrazosPage,
    })),
  ),
  saude: lazyWithRecovery(() =>
    import("../modules/saude/SaudePage").then((m) => ({
      default: m.SaudePage,
    })),
  ),
  ensino: lazyWithRecovery(() =>
    import("../modules/ensino/EnsinoPage").then((m) => ({
      default: m.EnsinoPage,
    })),
  ),
  forms: lazyWithRecovery(() =>
    import("../admin/FormsPage").then((m) => ({ default: m.FormsPage })),
  ),
  payments: lazyWithRecovery(() =>
    import("../admin/PaymentsPage").then((m) => ({ default: m.PaymentsPage })),
  ),
} satisfies Partial<Record<PageId, React.ComponentType>>;

/** A casca confere status, ativação e acesso antes de chegar aqui. */
export function ManagementPage({ page }: { page: PageId }): React.ReactElement {
  const Component = Object.hasOwn(pages, page)
    ? pages[page as keyof typeof pages]
    : null;
  return Component ? (
    <Component key={page} />
  ) : (
    <Empty title="Página não encontrada" />
  );
}
