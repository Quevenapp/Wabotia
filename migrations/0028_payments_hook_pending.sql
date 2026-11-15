-- Entrega durável do gancho onPaymentUpdated (revisão A3). A mudança de
-- estado grava, no mesmo UPDATE condicionado, a fila de ganchos pendentes
-- ([{id, status, previous}]); o gancho tira a entrada ao concluir. O reenvio
-- do webhook e o alarme da área repetem o que ficou pendente.
ALTER TABLE payments ADD COLUMN hook_pending TEXT;
ALTER TABLE payments ADD COLUMN hook_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN hook_next_at INTEGER;
ALTER TABLE payments ADD COLUMN hook_error TEXT;
CREATE INDEX payments_hook_pending ON payments(profile_id, hook_next_at)
  WHERE hook_pending IS NOT NULL;
