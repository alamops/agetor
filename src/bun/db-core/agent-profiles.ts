import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { type AgentProfile, type OpencodeServerMode, OPENCODE_SERVER_MODES, type Speed } from "../../shared/types.ts";
import { OPENCODE_SERVER_INPUT_ERROR } from "../../shared/opencode.ts";
import { AGENT_PROFILE_LIMITS } from "../../shared/agent-profile.ts";
import { AgentProfileNameError, isUniqueConstraintError } from "./errors.ts";
import { readOpencodeServer, sanitizeSkillsList, speedFields } from "./task-parsers.ts";

export type AgentProfileRow = {
  id: string;
  name: string;
  name_key: string;
  harness_id: string;
  model: string;
  effort: string | null;
  mode: string | null;
  speed: string;
  max_mode: number;
  // opencode only (migration 079): `OpencodeServerMode`, CHECK-guarded.
  opencode_server: string;
  instructions: string;
  skills_json: string;
  created_at: number;
  updated_at: number;
};

/** Parse the stored `skills_json` column through the same sanitizer
 *  {@link parseAgentProfileSnapshot} uses, tolerating malformed JSON or a
 *  non-array top level (both collapse to `[]` rather than throwing) — a
 *  profile row is our own write, but defensive parsing here costs nothing
 *  and matches every other JSON column in this file. */
export const parseSkillsJson = (raw: string): string[] => {
  try {
    return sanitizeSkillsList(JSON.parse(raw));
  } catch {
    return [];
  }
};

export const toAgentProfile = (r: AgentProfileRow): AgentProfile => ({
  id: r.id,
  name: r.name,
  harness: r.harness_id,
  model: r.model,
  effort: r.effort,
  mode: r.mode,
  ...speedFields(r.speed),
  maxMode: r.max_mode === 1,
  opencodeServer: readOpencodeServer(r.opencode_server),
  instructions: r.instructions,
  skills: parseSkillsJson(r.skills_json),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface AgentProfileInsertInput {
  name: string;
  harness: string;
  model: string;
  effort?: string | null;
  mode?: string | null;
  speed?: Speed;
  maxMode?: boolean;
  /** opencode only; omitted ⇒ `"shared"` on insert, unchanged on update. */
  opencodeServer?: OpencodeServerMode;
  instructions?: string;
  skills?: string[];
}

export interface AgentProfilePatch {
  name?: string;
  harness?: string;
  model?: string;
  effort?: string | null;
  mode?: string | null;
  speed?: Speed;
  maxMode?: boolean;
  /** opencode only; omitted ⇒ `"shared"` on insert, unchanged on update. */
  opencodeServer?: OpencodeServerMode;
  instructions?: string;
  skills?: string[];
}

/** Validate + normalize the name/instructions fields shared by `insert` and
 *  `update`: trims the name, rejects empty or over `AGENT_PROFILE_LIMITS.name`
 *  with a plain `Error` (mirrors `harnesses.insert`'s id-format check —
 *  these are caller/validation errors, not name-clash errors, so they're
 *  never `AgentProfileNameError`), and rejects instructions over
 *  `AGENT_PROFILE_LIMITS.instructions`. Returns the trimmed name and its
 *  lower-cased `name_key`. */
export const validateAgentProfileNameAndInstructions = (name: string, instructions: string): { name: string; nameKey: string } => {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("agent name is required");
  if (trimmed.length > AGENT_PROFILE_LIMITS.name) {
    throw new Error(`agent name must be ${AGENT_PROFILE_LIMITS.name} characters or fewer`);
  }
  if (instructions.length > AGENT_PROFILE_LIMITS.instructions) {
    throw new Error(`agent instructions must be ${AGENT_PROFILE_LIMITS.instructions} characters or fewer`);
  }
  return { name: trimmed, nameKey: trimmed.toLowerCase() };
};

/** `opencodeServer` on an agent-profile insert/patch: `undefined` passes
 *  through, a member of `OPENCODE_SERVER_MODES` passes as itself, anything
 *  else throws (the routes 400 on it first via `parseOpencodeServerInput`;
 *  this is the db-layer backstop ahead of the column's CHECK). */
export const validateOpencodeServer = (v: unknown): OpencodeServerMode | undefined => {
  if (v === undefined) return undefined;
  if ((OPENCODE_SERVER_MODES as readonly unknown[]).includes(v)) return v as OpencodeServerMode;
  throw new Error(OPENCODE_SERVER_INPUT_ERROR);
};

export function makeAgentProfiles(conn: Database) {
  /**
   * Reusable, named launch presets (`AgentProfile`, `shared/types.ts`) —
   * see `docs/plans/agent-profiles.md` for the full design. `harness_id` is a
   * soft reference: this module never validates that the harness exists (the
   * server does, via `harnesses.getByIdOrKind`, before calling `insert`) — a
   * profile pointing at a since-deleted harness id is expected once
   * `harnesses.delete`'s guard is bypassed by hand-editing the DB, and the
   * webview/CLI render it gracefully via the task-side snapshot's own
   * `harnessKind`/`harnessLabel` copy.
   */
  const agentProfiles = {
    list(): AgentProfile[] {
      return conn
        .query<AgentProfileRow, []>(
          `SELECT * FROM agent_profiles ORDER BY name_key ASC, id ASC`,
        )
        .all()
        .map(toAgentProfile);
    },
    get(id: string): AgentProfile | null {
      const row = conn
        .query<AgentProfileRow, [string]>(`SELECT * FROM agent_profiles WHERE id = ?`)
        .get(id);
      return row ? toAgentProfile(row) : null;
    },
    /** Case-insensitive, trimmed name lookup — the backing query for the
     *  unique-name check in `insert`/`update` and for `matchAgentProfileRef`'s
     *  CLI `<id|name>` resolution. */
    findByName(name: string): AgentProfile | null {
      const row = conn
        .query<AgentProfileRow, [string]>(`SELECT * FROM agent_profiles WHERE name_key = ?`)
        .get(name.trim().toLowerCase());
      return row ? toAgentProfile(row) : null;
    },
    insert(input: AgentProfileInsertInput): AgentProfile {
      const instructions = input.instructions ?? "";
      const { name, nameKey } = validateAgentProfileNameAndInstructions(input.name, instructions);
      const opencodeServer = validateOpencodeServer(input.opencodeServer) ?? "shared";
      if (this.findByName(name)) throw new AgentProfileNameError(name);

      const skills = sanitizeSkillsList(input.skills ?? []);
      const id = randomUUID();
      const now = Date.now();
      try {
        conn.run(
          `INSERT INTO agent_profiles
           (id, name, name_key, harness_id, model, effort, mode, speed, max_mode, opencode_server, instructions, skills_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, name, nameKey, input.harness, input.model,
            input.effort ?? null, input.mode ?? null,
            input.speed ?? "off", input.maxMode ? 1 : 0, opencodeServer,
            instructions, JSON.stringify(skills), now, now,
          ],
        );
      } catch (e) {
        if (isUniqueConstraintError(e)) throw new AgentProfileNameError(name);
        throw e;
      }
      return this.get(id) as AgentProfile;
    },
    update(id: string, patch: AgentProfilePatch): AgentProfile | null {
      const current = this.get(id);
      if (!current) return null;

      const nextNameRaw = patch.name !== undefined ? patch.name : current.name;
      const nextInstructions = patch.instructions !== undefined ? patch.instructions : current.instructions;
      const { name, nameKey } = validateAgentProfileNameAndInstructions(nextNameRaw, nextInstructions);
      if (patch.name !== undefined) {
        const clash = this.findByName(name);
        if (clash && clash.id !== id) throw new AgentProfileNameError(name);
      }

      const next = {
        harness: patch.harness ?? current.harness,
        model: patch.model ?? current.model,
        effort: patch.effort !== undefined ? patch.effort : current.effort,
        mode: patch.mode !== undefined ? patch.mode : current.mode,
        speed: patch.speed ?? current.speed,
        maxMode: patch.maxMode ?? current.maxMode,
        opencodeServer: validateOpencodeServer(patch.opencodeServer) ?? current.opencodeServer,
        skills: patch.skills !== undefined ? sanitizeSkillsList(patch.skills) : current.skills,
      };

      try {
        conn.run(
          `UPDATE agent_profiles SET
           name = ?, name_key = ?, harness_id = ?, model = ?, effort = ?, mode = ?, speed = ?, max_mode = ?, opencode_server = ?, instructions = ?, skills_json = ?, updated_at = ?
         WHERE id = ?`,
          [
            name, nameKey, next.harness, next.model, next.effort, next.mode,
            next.speed, next.maxMode ? 1 : 0, next.opencodeServer, nextInstructions, JSON.stringify(next.skills),
            Date.now(), id,
          ],
        );
      } catch (e) {
        if (isUniqueConstraintError(e)) throw new AgentProfileNameError(name);
        throw e;
      }
      return this.get(id);
    },
    /** Deleting a profile always succeeds — a task that was launched from it
     *  keeps its own frozen snapshot (D7 in the plan), so there is nothing to
     *  guard against here the way `harnesses.delete` must guard against
     *  in-use tasks/profiles. */
    delete(id: string): boolean {
      const current = this.get(id);
      if (!current) return false;
      conn.run(`DELETE FROM agent_profiles WHERE id = ?`, [id]);
      return true;
    },
    /** profileId -> count of tasks currently bound to it (`agent_profile_id =
     *  profileId`, every column including archived). One grouped query, the
     *  batch form the `GET /agent-profiles` list route uses so listing N
     *  profiles never issues N count queries. Detaching a task
     *  (`tasks.setAgentProfile(id, null, null)`) or deleting it lowers the
     *  count automatically since both clear/remove `agent_profile_id`. */
    taskCounts(): Map<string, number> {
      const rows = conn.query<{ agent_profile_id: string; n: number }, []>(
        `SELECT agent_profile_id, COUNT(*) AS n FROM tasks WHERE agent_profile_id IS NOT NULL GROUP BY agent_profile_id`,
      ).all();
      return new Map(rows.map((r) => [r.agent_profile_id, r.n]));
    },
    /** Single-profile count of tasks currently bound to it — for a
     *  single-resource response (GET/POST/PATCH `/agent-profiles/:id`) where a
     *  full grouped scan would be wasteful. */
    taskCount(id: string): number {
      const row = conn.query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM tasks WHERE agent_profile_id = ?`,
      ).get(id);
      return row?.n ?? 0;
    },
  };
  return agentProfiles;
}
