-- Pedido: pausa manual da loja ("loja fechada agora"). Fica fora das
-- configurações da área para a equipe da cozinha poder pausar e voltar sem
-- ser administradora. As demais regras da loja estão na chave "pedido" das
-- configurações da área.
CREATE TABLE IF NOT EXISTS pedido_store (
  profile_id TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  -- Texto opcional ao cliente enquanto pausada ("Voltamos às 19h").
  message TEXT NOT NULL DEFAULT '',
  updated INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
