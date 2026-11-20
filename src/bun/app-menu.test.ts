import { describe, expect, test } from "bun:test";
import { APP_MENU_ACTIONS, type AppEvent, type AppMenuAction } from "../shared/types.ts";
import { buildAppMenu, deliverMenuAction, menuActionFromClick, type DeliverMenuActionDeps, type MenuItem } from "./app-menu.ts";

type Submenu = { label: string; submenu: MenuItem[] };
function menu(label: string): MenuItem[] {
  const top = buildAppMenu().find((m): m is Submenu => "label" in m && m.label === label && "submenu" in m);
  if (!top?.submenu) throw new Error(`no menu ${label}`);
  return top.submenu;
}
const summary = (items: MenuItem[]) =>
  items.map((i) =>
    "type" in i ? "-" : `${"role" in i ? `role:${i.role}` : (i as { label: string }).label}${"action" in i && i.action ? `[${i.action}]` : ""}${i.accelerator ? ` ${i.accelerator}` : ""}`,
  );

describe("buildAppMenu", () => {
  test("top-level order: Agetor, Edit, Go, Window", () => {
    expect(buildAppMenu().map((m) => ("label" in m ? m.label : null))).toEqual(["Agetor", "Edit", "Go", "Window"]);
  });

  test("the Agetor menu keeps every existing item and adds Settings… ⌘, after About", () => {
    expect(summary(menu("Agetor"))).toEqual([
      "role:about",
      "-",
      "Settings…[webview:settings] Cmd+,",
      "-",
      "Remote Access…[remote-access]",
      "-",
      "role:hide Cmd+H",
      "role:hideOthers Cmd+Alt+H",
      "role:showAll",
      "-",
      "role:quit Cmd+Q",
      "Quit Agetor Completely[quit-completely] Cmd+Alt+Q",
    ]);
  });

  test("Edit and Window are unchanged", () => {
    expect(summary(menu("Edit"))).toEqual([
      "role:undo Cmd+Z",
      "role:redo Cmd+Shift+Z",
      "-",
      "role:cut Cmd+X",
      "role:copy Cmd+C",
      "role:paste Cmd+V",
      "role:pasteAndMatchStyle Cmd+Shift+Alt+V",
      "role:delete",
      "role:selectAll Cmd+A",
    ]);
    expect(summary(menu("Window"))).toEqual([
      "role:minimize Cmd+M",
      "role:zoom",
      "role:close Cmd+W",
      "-",
      "role:toggleFullScreen Ctrl+Cmd+F",
      "-",
      "role:bringAllToFront",
    ]);
  });

  test("the Go menu has the four actions in order, with no accelerators", () => {
    expect(summary(menu("Go"))).toEqual([
      "Pipelines[webview:pipelines]",
      "Worktrees…[webview:worktrees]",
      "Git Pull Requests and Issues…[webview:git]",
      "Import Sessions…[webview:import-sessions]",
    ]);
  });

  test("every webview action id in the template round-trips through menuActionFromClick", () => {
    const ids = buildAppMenu().flatMap((m) => ("submenu" in m && m.submenu ? m.submenu : []))
      .flatMap((i) => ("action" in i && i.action?.startsWith("webview:") ? [i.action] : []));
    expect(ids.map((a) => menuActionFromClick(a)).sort()).toEqual([...APP_MENU_ACTIONS].sort());
  });
});

describe("menuActionFromClick", () => {
  test("maps webview ids and rejects everything else", () => {
    expect(menuActionFromClick("webview:git")).toBe("git");
    expect(menuActionFromClick("webview:settings")).toBe("settings");
    for (const v of ["remote-access", "quit-completely", "webview:nope", "webview:", "git", "", undefined, null, 3]) {
      expect(menuActionFromClick(v)).toBeNull();
    }
  });
});

describe("deliverMenuAction", () => {
  function run(opts: { listeners: boolean; window: boolean }, action: AppMenuAction = "git") {
    const log: string[] = [];
    const events: AppEvent[] = [];
    const deps: DeliverMenuActionDeps = {
      hasListeners: () => opts.listeners,
      broadcast: (e) => {
        events.push(e);
        log.push("broadcast");
      },
      setPending: (a) => log.push(`pending:${a}`),
      hasWindow: () => opts.window,
      focusWindow: () => log.push("focus"),
      createWindow: () => {
        log.push("create");
        return Promise.resolve();
      },
      now: () => 42,
    };
    deliverMenuAction(action, deps);
    return { log, events };
  }

  test("window + client: broadcast once, focus, nothing parked", () => {
    const { log, events } = run({ listeners: true, window: true });
    expect(log).toEqual(["broadcast", "focus"]);
    expect(events).toEqual([{ type: "menu_action", action: "git", ts: 42 }]);
  });

  test("window, client not attached yet: parked, focus, no broadcast", () => {
    expect(run({ listeners: false, window: true }).log).toEqual(["pending:git", "focus"]);
  });

  test("no window: parked and a window is created, never focused", () => {
    expect(run({ listeners: false, window: false }).log).toEqual(["pending:git", "create"]);
  });

  test("no window with a CLI client on /app/events: still parked for the new webview, nothing broadcast", () => {
    expect(run({ listeners: true, window: false }).log).toEqual(["pending:git", "create"]);
  });

  test("a failed window creation is logged, never thrown", async () => {
    const logged: string[] = [];
    deliverMenuAction("settings", {
      hasListeners: () => false,
      broadcast: () => {},
      setPending: () => {},
      hasWindow: () => false,
      focusWindow: () => {},
      createWindow: () => Promise.reject(new Error("boom")),
      log: (m) => logged.push(m),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(logged).toHaveLength(1);
  });
});
