-- Cursor plan-approval records: plans detected from a run ending on
-- `createPlanToolCall` (the agent wrote a plan and stopped). Stored as a
-- JSON array of TaskPlan objects ({ id, toolCallId, runId, name, content,
-- editedContent, status, createdAt, approvedAt, approvedEdited, filePath }),
-- mirroring the `backlog` column pattern from migration 025. Legacy rows
-- default to an empty list.
ALTER TABLE tasks ADD COLUMN plans TEXT NOT NULL DEFAULT '[]';
