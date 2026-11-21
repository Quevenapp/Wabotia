// Porta de identidade (engine/identity.ts) e a projeção do Acesso
// (access/identity.ts): membership e profile seguem o envelope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import "../../../src/erp/domains/index.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { decodeIdentity, encodeIdentity, readIdentity } from "../../../src/erp/engine/identity.ts";
import { Clock } from "../../../src/erp/engine/time.ts";

const ana = randomUUID(),
  bia = randomUUID(),
  caio = randomUUID();
const person = (user_id, erp_role, name) => ({ user_id, name, email: `${name}@exemplo.invalid`, erp_role, verified_factor: false });
const actor = (p) => ({ ...p, session_id: randomUUID(), aal: "aal2", is_agent: false });

test("envelope: codifica, decodifica e descarta o que não confere", () => {
  const port = { actor: actor(person(ana, "admin", "Ana")), people: [person(ana, "admin", "Ana"), { user_id: "x" }, person(bia, "chefe", "Bia")] };
  const back = decodeIdentity(encodeIdentity(port));
  assert.equal(back.actor.aal, "aal2");
  assert.equal(back.people.length, 2);
  assert.equal(back.people[1].erp_role, null, "papel desconhecido vira sem papel");
  assert.deepEqual(decodeIdentity("lixo"), { actor: null, people: null });
  assert.deepEqual(readIdentity(null), { actor: null, people: null });
});

test("projeção: papel do Vinki em membership, nome em profile; sem papel fica inativo; nada muda sem mudança", () => {
  const lite = freshLite();
  const db = nodeDriver(lite);
  const clock = new Clock();
  const call = (people, as = ana) => callRpc(db, "erp_access_me", { p_user_id: as }, clock, { identity: { actor: actor(people.find((p) => p.user_id === as) ?? person(as, null, "x")), people } });
  const rows = () => lite.prepare('SELECT m.user_id, m.role, m.active, p.name FROM "erp_access__membership" m LEFT JOIN "erp_access__profile" p ON p.user_id=m.user_id ORDER BY m.user_id').all();
  call([person(ana, "admin", "Ana"), person(bia, "vendas", "Bia"), person(caio, null, "Caio")]);
  const first = rows();
  assert.deepEqual(first.map((r) => [r.user_id, r.role, r.active, r.name]).sort(), [[ana, "admin", 1, "Ana"], [bia, "vendas", 1, "Bia"]].sort());
  const changes = () => lite.prepare("SELECT total_changes() n").get().n;
  const before = changes();
  call([person(ana, "admin", "Ana"), person(bia, "vendas", "Bia"), person(caio, null, "Caio")]);
  assert.equal(changes() - before, 0, "mesmo diretório: nenhuma escrita");
  // Bia perde o erp:*, Ana troca de nome, Caio ganha papel.
  call([person(ana, "admin", "Ana Maria"), person(bia, null, "Bia"), person(caio, "estoque", "Caio")]);
  assert.deepEqual(rows().map((r) => [r.user_id, r.role, r.active, r.name]).sort(), [[ana, "admin", 1, "Ana Maria"], [bia, "vendas", 0, "Bia"], [caio, "estoque", 1, "Caio"]].sort());
  // Quem tem o módulo mas não tem papel erp:* recebe erp_access_denied (403 na erp-api).
  assert.throws(() => call([person(ana, "admin", "Ana Maria"), person(bia, null, "Bia")], bia), (e) => e.code === "42501");
  // Fora do diretório: inativo também.
  call([person(ana, "admin", "Ana Maria")]);
  assert.deepEqual(rows().filter((r) => r.active).map((r) => r.user_id), [ana]);
  lite.close();
});
