/**
 * One-line summaries of the collapsible launch sections. Shown while a section
 * is collapsed so the choices stay readable without opening it, and used to
 * announce a non-default value hidden behind "More options".
 */

export function workspaceSummary(i: {
  projectLabels: string[];
  /** Each selected project's base ref ("" / null = the current branch). */
  baseRefs: Array<string | null | undefined>;
  isolate: boolean;
  /** The branch the task will work on (isolated tasks only). */
  branch: string;
}): string {
  if (i.projectLabels.length === 0) return "No project selected";
  const parts: string[] = [];
  parts.push(i.projectLabels.length === 1 ? i.projectLabels[0]! : `${i.projectLabels.length} projects`);
  const ref = i.baseRefs[0]?.trim();
  if (i.projectLabels.length === 1) parts.push(ref ? ref : "current branch");
  parts.push(i.isolate ? "isolated" : "in place");
  if (i.isolate && i.branch.trim()) parts.push(i.branch.trim());
  return parts.join(" · ");
}

export function agentSummary(i: {
  pipelineName?: string | null;
  profileName?: string | null;
  harnessLabel: string;
  modelLabel?: string | null;
  effortLabel?: string | null;
  primary: "code" | "plan";
}): string {
  if (i.pipelineName) return `Pipeline · ${i.pipelineName}`;
  if (i.profileName) return `Agent · ${i.profileName}`;
  const parts = [i.harnessLabel];
  if (i.modelLabel) parts.push(i.modelLabel);
  if (i.effortLabel) parts.push(i.effortLabel);
  parts.push(i.primary === "plan" ? "Plan" : "Code");
  return parts.join(" · ");
}

/** The non-default rare values sitting behind a closed "More options". */
export function moreOptionsNotes(i: {
  speed?: string | null;
  speedLabel?: string | null;
  maxMode?: boolean;
  /** The label of a non-default code variant (e.g. "Accept edits"). */
  modeVariantLabel?: string | null;
  branchEdited?: boolean;
}): string[] {
  const notes: string[] = [];
  if (i.speed && i.speed !== "off") notes.push(`Speed: ${i.speedLabel ?? i.speed}`);
  if (i.maxMode) notes.push("Max Mode");
  if (i.modeVariantLabel) notes.push(`Mode: ${i.modeVariantLabel}`);
  if (i.branchEdited) notes.push("Branch name edited");
  return notes;
}
