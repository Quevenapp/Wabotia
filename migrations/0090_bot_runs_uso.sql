-- Uso de cada execução de bot com provedor de IA direto, em tokens:
-- {"input","cache_read","cache_write","output"}, somado entre as rodadas de
-- ferramentas e as tentativas de novo (docs/PROVEDOR-IA.md, "Cache").
-- Execuções pelo Hermes e as antigas: NULL.
ALTER TABLE bot_runs ADD COLUMN usage TEXT;
