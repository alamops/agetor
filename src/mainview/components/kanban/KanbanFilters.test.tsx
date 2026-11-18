// The board's filter row: the task count moved here from the app bar (D-P16)
// and the row wraps instead of widening the document at narrow widths.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { KanbanFilters } from "./KanbanFilters.tsx";

const noop = () => {};

function html(taskCount?: { visible: number; total: number }): string {
  return renderToStaticMarkup(
    <KanbanFilters
      textQuery=""
      onTextQueryChange={noop}
      repoFilter={[]}
      onRepoFilterChange={noop}
      statusFilter={[]}
      onStatusFilterChange={noop}
      archivedView="active"
      onArchivedViewChange={noop}
      harnessFilter={[]}
      onHarnessFilterChange={noop}
      typeFilter={[]}
      onTypeFilterChange={noop}
      projects={[]}
      harnesses={[]}
      taskAgentIds={[]}
      taskCount={taskCount}
    />,
  );
}

describe("KanbanFilters task count", () => {
  test("renders no count without the prop (the Pipelines page)", () => {
    expect(html()).not.toContain("board-task-count");
  });

  test("all visible: 'N tasks'", () => {
    const markup = html({ visible: 12, total: 12 });
    expect(markup).toContain('data-testid="board-task-count"');
    expect(markup).toContain(">12 tasks<");
  });

  test("filtered: 'X of N tasks'", () => {
    expect(html({ visible: 3, total: 12 })).toContain(">3 of 12 tasks<");
  });

  test("the count is right-aligned and never wraps itself", () => {
    const markup = html({ visible: 1, total: 1 });
    expect(markup).toContain("ml-auto");
    expect(markup).toContain("whitespace-nowrap");
    expect(markup).toContain(">1 tasks<");
  });
});

describe("KanbanFilters layout", () => {
  test("the row wraps and can shrink", () => {
    const markup = html();
    expect(markup).toContain("flex-wrap");
    expect(markup).toContain("min-w-0");
  });
});
