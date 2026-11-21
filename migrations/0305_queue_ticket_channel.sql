-- Fila de senhas em todos os canais de conversa (docs/FILA-SENHAS.md, "Outros
-- canais"). O canal de onde a senha foi retirada pela conversa: whatsapp,
-- instagram, facebook, telegram, tiktok ou app (chat do site / aplicação de
-- integração). NULL nas senhas do totem, do balcão e nas anteriores a esta
-- migração (source='whatsapp' continua sendo WhatsApp). A coluna source não
-- muda: senha de conversa segue gravada como 'whatsapp' (o CHECK da 0017 não
-- é reescrito). Só coluna nova; nada é apagado nem reescrito.
ALTER TABLE queue_tickets ADD COLUMN channel TEXT;
