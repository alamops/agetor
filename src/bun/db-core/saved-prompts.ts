import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { SavedPrompt } from "../../shared/types.ts";

export type SavedPromptRow = {
  id: string; name: string; content: string;
  created_at: number; updated_at: number;
};

export const toSavedPrompt = (r: SavedPromptRow): SavedPrompt => ({
  id: r.id,
  name: r.name,
  content: r.content,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface SavedPromptInsertInput {
  name: string;
  content: string;
}

export interface SavedPromptPatch {
  name?: string;
  content?: string;
}

export function makeSavedPrompts(conn: Database) {
  const savedPrompts = {
    list(): SavedPrompt[] {
      return conn
        .query<SavedPromptRow, []>(
          `SELECT * FROM saved_prompts ORDER BY created_at ASC, id ASC`,
        )
        .all()
        .map(toSavedPrompt);
    },
    get(id: string): SavedPrompt | null {
      const row = conn
        .query<SavedPromptRow, [string]>(`SELECT * FROM saved_prompts WHERE id = ?`)
        .get(id);
      return row ? toSavedPrompt(row) : null;
    },
    insert(input: SavedPromptInsertInput): SavedPrompt {
      const id = randomUUID();
      const now = Date.now();
      conn.run(
        `INSERT INTO saved_prompts (id, name, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
        [id, input.name, input.content, now, now],
      );
      return this.get(id) as SavedPrompt;
    },
    update(id: string, patch: SavedPromptPatch): SavedPrompt | null {
      const current = this.get(id);
      if (!current) return null;
      const next = {
        name: patch.name ?? current.name,
        content: patch.content ?? current.content,
      };
      conn.run(
        `UPDATE saved_prompts SET name = ?, content = ?, updated_at = ? WHERE id = ?`,
        [next.name, next.content, Date.now(), id],
      );
      return this.get(id);
    },
    delete(id: string): boolean {
      const current = this.get(id);
      if (!current) return false;
      conn.run(`DELETE FROM saved_prompts WHERE id = ?`, [id]);
      return true;
    },
  };
  return savedPrompts;
}
