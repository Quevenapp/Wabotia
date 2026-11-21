// Estoque › Check-in de Recebimentos: as notas recebidas da compra pela nota
// (Compras › Notas recebidas) que ainda não deram entrada. O check-in antigo
// lê só as notas de entrada cadastradas à mão; as que chegam do cofre ou pelo
// XML do fornecedor são conferidas e lançadas na tela delas, que este quadro
// abre. Sem Compras ligado (ou sem a porta), o quadro não aparece.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { erpPorts } from "./ports";
import type { ReceivedNote } from "./recebidas";

const money = (cents: number | null) => (cents === null ? "—" : (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const day = (value: string | null) => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10).split("-").reverse().join("/") : "—");

export default function CheckinRecebidas() {
  const port = erpPorts()?.recebidas;
  const on = !!port && port.access().parts.purchases;
  const [notes, setNotes] = useState<{ items: ReceivedNote[]; total: number } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!port || !on) return;
    const signal = new AbortController();
    port.list({ situacao: "pendentes" }, signal.signal).then((page) => setNotes({ items: page.items.filter((n) => n.situation === "autorizada" && n.role === "destinatario"), total: page.total }),
      (e) => { if (!(e instanceof Error && e.name === "AbortError")) setError(e instanceof Error ? e.message : "As notas recebidas não carregaram. Atualize a tela."); });
    return () => signal.abort();
  }, [port, on]);
  if (!port || !on) return null;
  return (
    <section className="checkin-recebidas" aria-label="Notas recebidas dos fornecedores">
      <h2>Notas recebidas dos fornecedores</h2>
      <p className="real-help">Notas que chegaram pelo cofre ou pelo XML do fornecedor e ainda não deram entrada. A conferência dos itens, a entrada no estoque e a baixa do pedido de compra são feitas na tela da nota.</p>
      {error && <p className="real-alert" role="alert">{error}</p>}
      {notes && !notes.items.length && <p className="empty-state">Nenhuma nota recebida esperando entrada.</p>}
      {notes && notes.items.length > 0 && (
        <ul className="checkin-note-list">
          {notes.items.map((n) => (
            <li key={n.id}>
              <Link className="checkin-note-card" to={`/notas-recebidas-compras?nota=${n.id}`}>
                <strong>NFe {n.number ?? "—"}{n.series ? `/${n.series}` : ""}</strong>
                <span className="status-badge status-neutral">{n.xml ? "Para conferir e dar entrada" : "Só o resumo: falta o XML"}</span>
                <small>{n.supplier?.name ?? n.emitter.name ?? "Fornecedor"} · emitida em {day(n.issued_on)} · {money(n.total_cents)}</small>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {notes && notes.total > notes.items.length && <p><Link to="/notas-recebidas-compras">Ver todas as notas recebidas</Link></p>}
    </section>
  );
}
