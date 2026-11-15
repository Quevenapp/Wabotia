-- Passagem para humano feita por um módulo (ctx.handoff): JSON
-- {module, summary, flags, at} que o atendente vê na conversa. Limpo na
-- próxima passagem sem dados de módulo e ao encerrar a conversa.
ALTER TABLE conversations ADD COLUMN handoff TEXT;
