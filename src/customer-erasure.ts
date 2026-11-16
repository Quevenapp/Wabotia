// Relacionamento e eliminação de dados de um cliente nas tabelas do núcleo
// (LGPD, art. 18, VI). Usado pelo Cadastro de clientes (src/modules/clientes)
// pelos métodos ctx.customerConversations, ctx.customerTickets e
// ctx.eraseConversations (docs/MODULOS.md). O núcleo é o único que grava nas
// próprias tabelas: o módulo só pede.
//
// O que fica: a linha da conversa (id, área, linha, datas, estado) e a do
// protocolo (id, número, estado, datas), sem conteúdo. São os "vínculos de
// atendimento" que o pedido de exclusão preserva. Cobranças ficam (valor,
// estado e datas são registro financeiro; não têm dado do pagador).
import { all, batch, one } from "./db";
import { json, now, type Env } from "./types";
import { phoneVariants } from "./service";

/** Texto que substitui o título do protocolo apagado. */
const ERASED = "Dados excluídos a pedido do titular";

/** Variações aceitas de uma lista de telefones (com e sem o 9 do celular). */
export function phonesVariants(phones: string[]) {
  const out = new Set<string>();
  for (const phone of phones)
    try {
      for (const v of phoneVariants(phone)) out.add(v);
    } catch {
      // Telefone fora do formato: não casa com conversa nenhuma.
    }
  return [...out];
}

export interface CustomerConversation {
  id: string;
  connection_id: string | null;
  state: string;
  created: number;
  updated: number;
  last_customer: number;
}

/**
 * Conversas individuais da área com algum dos telefones, autenticados pelo
 * canal (external_namespace da própria linha), mais recentes primeiro.
 */
export async function conversationsByPhones(
  env: Env,
  profile: string,
  phones: string[],
  limit = 50,
): Promise<CustomerConversation[]> {
  const variants = phonesVariants(phones);
  if (!variants.length) return [];
  return all<CustomerConversation>(
    env,
    `SELECT id,connection_id,state,created,updated,last_customer FROM conversations
     WHERE profile_id=? AND chat_type='direct' AND connection_id IS NOT NULL
       AND external_namespace='channel:'||connection_id
       AND (phone IN (SELECT value FROM json_each(?)) OR external_id IN (SELECT value FROM json_each(?)))
     ORDER BY updated DESC,id DESC LIMIT ?`,
    profile,
    JSON.stringify(variants),
    JSON.stringify(variants),
    Math.max(1, Math.min(200, limit)),
  );
}

/** Protocolos das conversas dadas (id, número, estado, título, datas). */
export async function ticketsOfConversations(
  env: Env,
  profile: string,
  conversationIds: string[],
  limit = 100,
) {
  if (!conversationIds.length) return [];
  return all(
    env,
    "SELECT id,number,status,title,conversation_id,created,updated FROM tickets WHERE profile_id=? AND conversation_id IN (SELECT value FROM json_each(?)) ORDER BY created DESC,id DESC LIMIT ?",
    profile,
    JSON.stringify(conversationIds),
    Math.max(1, Math.min(500, limit)),
  );
}

export interface EraseConversationsResult {
  conversations: number;
  tickets: number;
  messages: number;
  contacts: number;
  media: number;
  /** Envios ainda na fila: a identidade da conversa fica até saírem. */
  pending_outbox: number;
  identity_released: boolean;
}

/**
 * Apaga o conteúdo pessoal das conversas dadas, que precisam ser da área.
 * Em uma rodada, com um lote do D1 (as instruções valem juntas):
 * - mensagens e anexos recebidos do cliente (objeto no R2 também);
 * - textos dos protocolos (título vira o aviso, andamentos somem);
 * - respostas de passos web, evidência de consentimentos, comentário de
 *   avaliação, entrada da caixa de mensagens, envios já concluídos;
 * - entrada e resultado das execuções de bots;
 * - contatos da agenda vinculados a essas conversas ou com esses telefones
 *   (equipe), e os vínculos conversa→contato;
 * - eventos dessas conversas, protocolos, passos web e mensagens (payload
 *   vira `{"erased":true}`);
 * - telefone das senhas da fila e permissões de ligação.
 *
 * `releaseIdentity`: além disso, tira o telefone da conversa (external_id
 * vira `erased:<id>`, phone nulo) e a encerra. Só quando não há envio
 * pendente para ela; com envio pendente (a confirmação ao cliente), devolve
 * `identity_released: false` e quem chama tenta de novo depois. Uma mensagem
 * nova do cliente depois disso abre outra conversa, sem histórico.
 *
 * Idempotente: repetir não muda o resultado.
 */
export async function eraseConversations(
  env: Env,
  profile: string,
  conversationIds: string[],
  phones: string[],
  options: { releaseIdentity?: boolean; force?: boolean } = {},
): Promise<EraseConversationsResult> {
  const own = conversationIds.length
    ? (
        await all(
          env,
          "SELECT id FROM conversations WHERE profile_id=? AND chat_type='direct' AND id IN (SELECT value FROM json_each(?))",
          profile,
          JSON.stringify(conversationIds),
        )
      ).map((r) => r.id as string)
    : [];
  const ids = JSON.stringify(own);
  const variants = JSON.stringify(phonesVariants(phones));
  const counts = await one(
    env,
    `SELECT
       (SELECT count(*) FROM messages WHERE conversation_id IN (SELECT value FROM json_each(?1))) messages,
       (SELECT count(*) FROM tickets WHERE profile_id=?2 AND conversation_id IN (SELECT value FROM json_each(?1))) tickets,
       (SELECT count(*) FROM outbox WHERE conversation_id IN (SELECT value FROM json_each(?1)) AND status IN ('pending','sending','unknown')) pending`,
    ids,
    profile,
  );
  // Anexos que o cliente mandou (mensagens recebidas): o arquivo sai do R2.
  const media: { id: string; object_key: string }[] = [];
  for (const row of await all(
    env,
    "SELECT attachments FROM messages WHERE conversation_id IN (SELECT value FROM json_each(?)) AND direction='inbound' AND attachments<>'[]'",
    ids,
  ))
    for (const item of json(row.attachments, []) as any[]) {
      const id = typeof item === "string" ? item : item?.id;
      if (typeof id !== "string") continue;
      const m = await one(
        env,
        "SELECT id,object_key FROM media WHERE id=? AND profile_id=?",
        id,
        profile,
      );
      if (m) media.push(m);
    }
  const contacts = (
    await all(
      env,
      `SELECT DISTINCT c.id FROM contacts c WHERE c.profile_id=?1 AND (
         c.id IN (SELECT contact_id FROM conversation_contacts WHERE profile_id=?1 AND conversation_id IN (SELECT value FROM json_each(?2)))
         OR (c.namespace='team' AND replace(replace(replace(replace(replace(c.phone,'+',''),' ',''),'(',''),')',''),'-','') IN (SELECT value FROM json_each(?3))))`,
      profile,
      ids,
      variants,
    )
  ).map((r) => r.id as string);
  const contactIds = JSON.stringify(contacts);
  const at = now();
  const erased = JSON.stringify({ erased: true });
  // `force`: libera mesmo com envio pendente (preso há muito tempo); o envio
  // é cancelado antes de perder o destino.
  const release =
    !!options.releaseIdentity && (!!options.force || !counts?.pending);
  const statements: [string, any[]][] = [
    // Eventos primeiro: os ids de mensagem ainda existem.
    [
      `UPDATE events SET payload=? WHERE profile_id=? AND (
         resource_id IN (SELECT value FROM json_each(?))
         OR resource_id IN (SELECT id FROM tickets WHERE profile_id=? AND conversation_id IN (SELECT value FROM json_each(?)))
         OR resource_id IN (SELECT id FROM web_steps WHERE profile_id=? AND conversation_id IN (SELECT value FROM json_each(?)))
         OR resource_id IN (SELECT id FROM messages WHERE conversation_id IN (SELECT value FROM json_each(?)))
         OR resource_id IN (SELECT value FROM json_each(?))
         OR json_extract(payload,'$.conversation_id') IN (SELECT value FROM json_each(?)))`,
      [erased, profile, ids, profile, ids, profile, ids, ids, contactIds, ids],
    ],
    [
      "DELETE FROM ticket_updates WHERE ticket_id IN (SELECT id FROM tickets WHERE profile_id=? AND conversation_id IN (SELECT value FROM json_each(?)))",
      [profile, ids],
    ],
    [
      "UPDATE tickets SET title=? WHERE profile_id=? AND conversation_id IN (SELECT value FROM json_each(?))",
      [ERASED, profile, ids],
    ],
    [
      "DELETE FROM messages WHERE conversation_id IN (SELECT value FROM json_each(?))",
      [ids],
    ],
    [
      "UPDATE inbox SET payload='{}' WHERE conversation_id IN (SELECT value FROM json_each(?))",
      [ids],
    ],
    [
      `UPDATE outbox SET payload='{}' WHERE conversation_id IN (SELECT value FROM json_each(?))${release ? "" : " AND status NOT IN ('pending','sending','unknown')"}`,
      [ids],
    ],
    [
      "UPDATE web_steps SET result=NULL,contact_id=NULL WHERE profile_id=? AND conversation_id IN (SELECT value FROM json_each(?))",
      [profile, ids],
    ],
    [
      "UPDATE consents SET evidence='{}' WHERE profile_id=? AND conversation_id IN (SELECT value FROM json_each(?))",
      [profile, ids],
    ],
    [
      "UPDATE surveys SET comment='' WHERE profile_id=? AND conversation_id IN (SELECT value FROM json_each(?))",
      [profile, ids],
    ],
    [
      "UPDATE bot_runs SET input='{}',result=NULL,error=NULL,context='{}' WHERE profile_id=? AND conversation_id IN (SELECT value FROM json_each(?))",
      [profile, ids],
    ],
    [
      "UPDATE queue_tickets SET phone=NULL WHERE profile_id=? AND (conversation_id IN (SELECT value FROM json_each(?)) OR phone IN (SELECT value FROM json_each(?)))",
      [profile, ids, variants],
    ],
    [
      "DELETE FROM call_permissions WHERE recipient IN (SELECT value FROM json_each(?)) AND connection_id IN (SELECT id FROM connections WHERE profile_id=?)",
      [variants, profile],
    ],
    [
      "DELETE FROM conversation_contacts WHERE profile_id=? AND (conversation_id IN (SELECT value FROM json_each(?)) OR contact_id IN (SELECT value FROM json_each(?)))",
      [profile, ids, contactIds],
    ],
    [
      "DELETE FROM contacts WHERE profile_id=? AND id IN (SELECT value FROM json_each(?))",
      [profile, contactIds],
    ],
    [
      "UPDATE conversations SET topic=NULL,tags='[]',title='',handoff=NULL,menu_items='[]',menu_active=0,menu_token=NULL,updated=? WHERE profile_id=? AND id IN (SELECT value FROM json_each(?))",
      [at, profile, ids],
    ],
  ];
  for (const m of media)
    statements.push([
      "DELETE FROM media WHERE id=? AND profile_id=?",
      [m.id, profile],
    ]);
  if (release)
    statements.push(
      [
        "UPDATE outbox SET status='cancelled',error='Dados excluídos a pedido do titular.',updated=? WHERE conversation_id IN (SELECT value FROM json_each(?)) AND status='pending'",
        [at, ids],
      ],
      [
        "DELETE FROM router_affinities WHERE profile_id=? AND conversation_id IN (SELECT value FROM json_each(?))",
        [profile, ids],
      ],
      [
        "UPDATE conversations SET phone=NULL,recipient_id=NULL,external_id='erased:'||id,state='closed',owner=NULL,assigned_bot_id=NULL,epoch=epoch+1,updated=? WHERE profile_id=? AND id IN (SELECT value FROM json_each(?))",
        [at, profile, ids],
      ],
    );
  if (own.length || contacts.length) await batch(env, statements);
  for (const m of media)
    try {
      await env.MEDIA.delete(m.object_key);
    } catch {
      // A linha já saiu; um objeto órfão no R2 não é lido por ninguém.
    }
  return {
    conversations: own.length,
    tickets: counts?.tickets ?? 0,
    messages: counts?.messages ?? 0,
    contacts: contacts.length,
    media: media.length,
    pending_outbox: counts?.pending ?? 0,
    identity_released: release || !own.length,
  };
}
