-- fx model-response-recovery pause + auto-resume schedule (`TaskFxRecovery` JSON, src/shared/types.ts), written only by `tasks.setFxRecovery`, never by the generic `tasks.update` SET clause. NULL for every task that isn't currently paused.
ALTER TABLE tasks ADD COLUMN fx_recovery TEXT;
