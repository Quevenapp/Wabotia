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

/** Opcionais do ERP com chave própria em Gestão → Módulos (PLANO-FAGOO.md, item 16). */
const OPTIONAL = [
  "erp-fiscal",
  "erp-cobranca",
  "erp-pdv",
  "erp-origin",
] as const;

export function ErpArea() {
  const app = useApp();
  if (!app.moduleOn("erp"))
    return (
      <div className="area">
        <Empty
          title="ERP desligado"
          description={
            app.isAdmin
              ? "O ERP está desligado nesta área de atendimento. Ligue-o em Gestão → Módulos."
              : "O ERP está desligado nesta área de atendimento. Fale com o administrador."
          }
          action={
            app.isAdmin ? (
              <Button
                onClick={() => navigate({ area: "admin", page: "modules" })}
              >
                Abrir Módulos
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  const blocks = Object.fromEntries(
    OPTIONAL.map((id) => [id, app.moduleOn(id)]),
  );
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
            key={JSON.stringify(blocks)}
            profile={app.profile}
            actor={String(app.me.id)}
            demo={app.demo}
            blocks={blocks}
            admin={app.isAdmin}
            onModules={() => navigate({ area: "admin", page: "modules" })}
            onLeave={() => navigate({ area: "conversations" })}
            onExpired={() => void app.reloadSession()}
          />
        </Suspense>
      </LoadBoundary>
    </div>
  );
}
