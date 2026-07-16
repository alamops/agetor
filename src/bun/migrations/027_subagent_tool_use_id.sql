-- The parent `Agent` tool_use id for a subagent (meta.json.toolUseId), so a
-- subagent whose own transcript never writes a terminal `stop_reason:"end_turn"`
-- line can still be settled by correlating this id against a `tool_result`
-- block in the MAIN session JSONL (claude's own "this Task call returned"
-- signal). Nullable: older rows (pre-fix) and any row whose meta sidecar
-- lacked the field backfill this on watcher reattach; a NULL value simply
-- means the tool_result scan has nothing to match for that row.
ALTER TABLE subagents ADD COLUMN tool_use_id TEXT;
