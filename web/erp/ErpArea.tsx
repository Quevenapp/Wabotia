// Área ERP do painel (/app/erp/…): limite do carregamento sob demanda. Nada do
// Fagoo (web/erp/app) entra no pacote inicial do painel; o import() abaixo é a
// única porta (tests/erp-painel-build.test.ts confere no build).
import React, { lazy, Suspense } from "react";
import { useApp } from "../app/AppContext";
import { navigate } from "../lib/routes";
import { Empty, Spinner, Button } from "../ui";

const ErpMount = lazy(() => import("./mount"));

class LoadBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="area">
        <Empty
          title="Não foi possível abrir o ERP"
          description="Confira a conexão e recarregue a página. Se o painel acabou de ser atualizado, recarregar busca a versão nova."
          action={<Button onClick={() => location.reload()}>Recarregar</Button>}
        />
      </div>
    );
  }
}

export function ErpArea() {
  const app = useApp();
  return (
    <div className="erp-area">
      <LoadBoundary>
        <Suspense
          fallback={
            <div className="loading">
              <Spinner label="Abrindo o ERP…" />
            </div>
          }
        >
          <ErpMount
            profile={app.profile}
            actor={String(app.me.id)}
            demo={app.demo}
            onLeave={() => navigate({ area: "conversations" })}
            onExpired={() => void app.reloadSession()}
          />
        </Suspense>
      </LoadBoundary>
    </div>
  );
}
