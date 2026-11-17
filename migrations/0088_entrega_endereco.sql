-- Entrega: endereço com os campos separados (rua, número, complemento,
-- bairro, cidade, UF, CEP, referência), em JSON, completado com a cidade e a
-- UF da loja quando o pedido não as tem. O app do entregador procura o
-- destino com eles (docs/ENTREGA.md, "Endereço"). Entregas antigas: NULL.
ALTER TABLE entrega_deliveries ADD COLUMN address TEXT;
