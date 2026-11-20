import type { Database } from "bun:sqlite";
import path from "node:path";
import type { BranchNamingConfig, Project } from "../../shared/types.ts";

export type ProjectRow = { path: string; name: string; added_at: number; branch_config: string | null };

/** Parse the stored branch-config JSON, tolerating legacy NULLs and bad data. */
export function parseBranchConfig(raw: string | null): BranchNamingConfig | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && "rules" in v) return v as BranchNamingConfig;
  } catch {
    /* corrupt row — treat as "no custom config" so consumers use defaults */
  }
  return null;
}

export const toProject = (r: ProjectRow): Project => ({
  path: r.path,
  name: r.name,
  addedAt: r.added_at,
  branchConfig: parseBranchConfig(r.branch_config),
});

export function makeProjects(conn: Database) {
  const projects = {
    list(): Project[] {
      return conn.query<ProjectRow, []>(
        `SELECT * FROM projects ORDER BY added_at DESC`,
      ).all().map(toProject);
    },
    get(path: string): Project | null {
      const row = conn.query<ProjectRow, [string]>(
        `SELECT * FROM projects WHERE path = ?`,
      ).get(path);
      return row ? toProject(row) : null;
    },
    /**
     * Insert if new, refresh `added_at` if already present. The refresh lets the
     * picker surface "recently used" paths at the top — every task creation
     * bumps its project to the front. `branch_config` is left untouched on
     * conflict so re-picking a project doesn't wipe its nomenclature.
     */
    upsert(path: string, name: string): Project {
      const now = Date.now();
      conn.run(
        `INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET added_at = excluded.added_at`,
        [path, name, now],
      );
      return this.get(path)!;
    },
    /**
     * Persist (or clear, with `null`) a project's branch nomenclature. Returns
     * the refreshed row, or null if the project isn't registered.
     */
    setBranchConfig(path: string, config: BranchNamingConfig | null): Project | null {
      conn.run(
        `UPDATE projects SET branch_config = ? WHERE path = ?`,
        [config ? JSON.stringify(config) : null, path],
      );
      return this.get(path);
    },
    delete(path: string) {
      conn.run(`DELETE FROM projects WHERE path = ?`, [path]);
    },
  };
  return projects;
}
