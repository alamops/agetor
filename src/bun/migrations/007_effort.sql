-- Reasoning-effort knob, surfaced beside the model picker. NULL means "use
-- the agent's default" (no flag passed). Currently only codex's reasoning
-- models consume this (`-c model_reasoning_effort=…`); claude-code stores it
-- for future use but doesn't translate it to a CLI flag yet.
ALTER TABLE tasks ADD COLUMN effort TEXT;
