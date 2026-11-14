-- Orientação do administrador sobre quando e como o bot pode usar cada fonte
-- do Conhecimento. Vai junto com os trechos da fonte para o bot.
ALTER TABLE documents ADD COLUMN usage TEXT;
