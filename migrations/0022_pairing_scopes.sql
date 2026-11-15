-- Permissões pedidas pelo próprio aparelho em /api/pairing/start (docs/PAREAMENTO.md).
-- NULL: pedido antigo, sem scopes; vale a lista completa do cliente, como antes.
ALTER TABLE pairing_requests ADD COLUMN requested_scopes TEXT;
