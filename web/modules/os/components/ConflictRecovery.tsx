import React, { useState } from "react";
import { Button, Notice } from "../../../ui";
import { workError } from "../work-api";

export interface ReloadedRecord<T> {
  record?: T;
  successor?: T;
}

/** A versão-base só avança depois de a pessoa comparar e aceitar a recarga. */
export function useConflictRecovery<T extends { version: number; archived_at?: number | null }>(
  initial: T | undefined,
  load: () => Promise<ReloadedRecord<T>>,
) {
  const [base, setBase] = useState(initial);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<ReloadedRecord<T>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return {
    base,
    conflict,
    latest,
    busy,
    error,
    async run(save: () => Promise<unknown>) {
      if (conflict)
        throw new Error("Compare a versão atual antes de salvar novamente.");
      try {
        await save();
      } catch (error) {
        if (["version_conflict", "entry_replaced", "entry_archived"].includes(
          (error as { code?: string }).code || "",
        )) {
          setConflict(true);
          setLatest(undefined);
        }
        throw error;
      }
    },
    async reload() {
      setBusy(true);
      setError("");
      setLatest(undefined);
      try {
        setLatest(await load());
      } catch (error) {
        setError(workError(error));
      } finally {
        setBusy(false);
      }
    },
    accept() {
      if (busy || !latest?.record || latest.record.archived_at || latest.successor) return;
      setBase(latest.record);
      setConflict(false);
      setLatest(undefined);
    },
  };
}

export function ConflictRecovery<T extends { version: number; archived_at?: number | null }>({
  recovery,
  children,
}: {
  recovery: ReturnType<typeof useConflictRecovery<T>>;
  children?: React.ReactNode;
}) {
  if (!recovery.conflict) return null;
  return (
    <Notice>
      <p>Outra pessoa alterou este registro. Seu rascunho permanece nos campos abaixo.</p>
      <Button secondary disabled={recovery.busy} onClick={() => void recovery.reload()}>
        Recarregar versão atual para comparar
      </Button>
      {recovery.error && <p role="alert">{recovery.error}</p>}
      {recovery.latest && (
        <>
          {!recovery.latest.record ? (
            <p>Registro indisponível ou arquivado. O rascunho foi preservado.</p>
          ) : (
            <>
              <p>Versão atual: {recovery.latest.record.version}. Compare antes de aplicar seu rascunho.</p>
              {children}
              {recovery.latest.successor ? (
                <p>Este lançamento já foi retificado. Consulte o sucessor antes de fazer outra retificação.</p>
              ) : recovery.latest.record.archived_at ? (
                <p>Registro arquivado. Não é possível substituir esta versão.</p>
              ) : (
                <Button secondary onClick={recovery.accept}>
                  Usar esta versão e manter meu rascunho
                </Button>
              )}
            </>
          )}
        </>
      )}
    </Notice>
  );
}
