-- Retirada do Hermes, passo 1 (nota sessao-F-retirada-hermes.md, §4): o
-- Wabotia passa a trabalhar só com bots internos (provedor de IA direto).
-- Só dados, aditiva: não apaga tabela nem linha. O código anterior continua
-- rodando com estes dados (conexão pausada já era um estado normal), se o
-- publish falhar depois do migrate. O painel mostra o cartão "Hermes
-- retirado" (web/admin/ConnectionsPage.tsx).

-- Linhas que atendiam com um bot do Hermes voltam à regra da área (inherit:
-- Atendente interno, menu ou equipe).
UPDATE connections
SET config = json_set(config, '$.service.mode', 'inherit', '$.service.bot_id', NULL)
WHERE json_extract(config, '$.service.mode') = 'bot'
  AND json_extract(config, '$.service.bot_id') IN (
    SELECT b.id FROM bots b JOIN connections c ON c.id = b.connection_id WHERE c.kind = 'hermes'
  );

-- Atendente da área que era um bot do Hermes: fica vago (o painel pede um
-- bot interno).
UPDATE profiles
SET settings = json_remove(settings, '$.attendant_bot')
WHERE json_extract(settings, '$.attendant_bot') IN (
  SELECT b.id FROM bots b JOIN connections c ON c.id = b.connection_id WHERE c.kind = 'hermes'
);

-- Ações de especialista com bot do Hermes: desligadas, guardadas para serem
-- apontadas a um especialista interno.
UPDATE profiles
SET settings = json_set(
  settings,
  '$.capabilities',
  (
    SELECT json_group_array(
      CASE
        WHEN json_extract(value, '$.bot_id') IN (
          SELECT b.id FROM bots b JOIN connections c ON c.id = b.connection_id WHERE c.kind = 'hermes'
        ) THEN json_set(value, '$.enabled', json('false'))
        ELSE json(value)
      END
    )
    FROM json_each(profiles.settings, '$.capabilities')
  )
)
WHERE json_type(settings, '$.capabilities') = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(profiles.settings, '$.capabilities') AS cap
    WHERE json_extract(cap.value, '$.bot_id') IN (
      SELECT b.id FROM bots b JOIN connections c ON c.id = b.connection_id WHERE c.kind = 'hermes'
    )
  );

-- Conversa atribuída a um bot do Hermes: sem bot (a próxima mensagem segue a
-- regra da linha e da área).
UPDATE conversations
SET assigned_bot_id = NULL
WHERE assigned_bot_id IN (
  SELECT b.id FROM bots b JOIN connections c ON c.id = b.connection_id WHERE c.kind = 'hermes'
);

-- Bots do Hermes desligados; o histórico das execuções fica.
UPDATE bots SET enabled = 0
WHERE connection_id IN (SELECT id FROM connections WHERE kind = 'hermes');

-- Chaves de aplicação do perfil Hermes revogadas sempre: a aplicação cujos
-- bots são de conexão hermes ou hermes-whatsapp. A chave guardada no servidor
-- do Hermes deixa de valer; uma integração que continue recebe chave nova,
-- sem bots. A aplicação fica (registro e auditoria).
UPDATE api_keys SET revoked = 1
WHERE revoked = 0
  AND app_id IN (
    SELECT a.id FROM applications a
    WHERE json_valid(a.bots) AND EXISTS (
      SELECT 1 FROM json_each(a.bots) j
      JOIN bots b ON b.id = j.value
      JOIN connections c ON c.id = b.connection_id
      WHERE c.kind IN ('hermes', 'hermes-whatsapp')
    )
  );

-- Conexões do Hermes (bots e o canal hermes-whatsapp) pausadas e marcadas.
UPDATE connections
SET status = 'paused', config = json_set(config, '$.retired', 1)
WHERE kind IN ('hermes', 'hermes-whatsapp');
