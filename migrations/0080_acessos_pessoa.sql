-- Acesso por pessoa (src/access.ts): lista JSON do que o atendente usa no
-- painel e nos apps, como ["*"] (atendente completo), ["caixa:cashier"] (só
-- caixa) ou ["os", "os:technician"]. NULL vale como ["*"]: quem já é
-- atendente continua com tudo o que tinha. O administrador ignora a lista.
ALTER TABLE users ADD COLUMN access TEXT;
