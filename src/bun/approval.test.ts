import { test, expect } from "bun:test";
import { isApprovalPrompt } from "../shared/types.ts";

test("matches common claude-code / codex approval phrasings", () => {
  const positives = [
    "Do you want me to apply this patch?",
    "Do you want to continue (y/n)?",
    "Please confirm the destructive action.",
    "Approval required to proceed",
    "Approval needed for shell command",
    "Waiting for your approval",
    "Would you like to retry?",
    "Proceed? (y/n)",
    "Yes/No",
    "[y/n]",
  ];
  for (const s of positives) expect(isApprovalPrompt(s)).toBe(true);
});

test("ignores normal agent chatter", () => {
  const negatives = [
    "Reading file src/main.ts",
    "Running tests...",
    "Building artifact",
    "Wrote 12 lines to README.md",
    "All checks passed",
  ];
  for (const s of negatives) expect(isApprovalPrompt(s)).toBe(false);
});
