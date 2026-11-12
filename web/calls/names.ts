// O histórico de ligações traz só o id da conversa. Aqui resolvemos nome e
// telefone com uma consulta leve à lista de conversas (e, para as que ficaram
// de fora, ao detalhe de cada uma, poucas por vez).
import { useEffect, useState } from "react";
import { useApp } from "../app/AppContext";
import type { Row } from "../lib/api";

const cache = new Map<string, Map<string, Row>>();
const listed = new Map<string, Promise<void>>();
const pending = new Set<string>();

export function useConversationLookup(ids: string[]) {
  const app = useApp();
  const [, bump] = useState(0);
  const key = ids.join(",");
  useEffect(() => {
    if (!ids.length) return;
    let alive = true;
    const known = cache.get(app.root) || new Map<string, Row>();
    cache.set(app.root, known);
    const remember = (row: Row) => row?.id && known.set(row.id, row);
    (async () => {
      if (!listed.has(app.root))
        listed.set(
          app.root,
          app
            .api(app.root + "/conversations?limit=100")
            .then((page) => (page.data || []).forEach(remember))
            .catch(() => {
              listed.delete(app.root);
            }),
        );
      await listed.get(app.root);
      if (alive) bump((n) => n + 1);
      const missing = [...new Set(ids)]
        .filter((id) => !known.has(id) && !pending.has(app.root + id))
        .slice(0, 12);
      for (const id of missing) {
        pending.add(app.root + id);
        try {
          const detail = await app.api(
            `${app.root}/conversations/${encodeURIComponent(id)}`,
          );
          remember({
            ...detail.conversation,
            contact_name: detail.contact?.name || null,
          });
          if (alive) bump((n) => n + 1);
        } catch {
          /* sem acesso à conversa: o histórico mostra um nome genérico */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [app.root, key]);
  return (id: string): Row | undefined => cache.get(app.root)?.get(id);
}
