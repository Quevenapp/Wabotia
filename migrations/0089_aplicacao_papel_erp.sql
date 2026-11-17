-- Papel do ERP de uma aplicação com o escopo erp:write (src/modules/erp/identity.ts):
-- consulta, vendas, estoque ou fiscal, escolhido pelo administrador. NULL: sem papel
-- (com erp:write, 403 erp_role_required; erp:read vale consulta sem escolher).
ALTER TABLE applications ADD COLUMN erp_role TEXT;
