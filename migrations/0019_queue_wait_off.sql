-- Tempo de espera desligado por fila: o cliente, o painel e o totem não veem
-- estimativa. wait_mode continua guardando average/fixed para quando religar.
ALTER TABLE queues ADD COLUMN show_wait INTEGER NOT NULL DEFAULT 1;
