// Static-markup contract of the launch primitives (no DOM in `bun test`): the
// roles, attributes and label wiring the e2e specs and screen readers rely on.
// Interaction (keyboard, positioning) is covered by the pure-helper tests and
// e2e/launch-keyboard.spec.ts.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Field, FieldError, FieldLabel, useFieldControl } from "./field.tsx";
import { Picker } from "./picker.tsx";
import { SegmentedControl } from "./segmented-control.tsx";
import { Notice } from "./notice.tsx";
import { Disclosure } from "./disclosure.tsx";
import { ResizeHandle } from "./resize-handle.tsx";
import { Kbd } from "./kbd.tsx";
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "./dialog.tsx";

function Control() {
  const c = useFieldControl();
  return <input {...c} />;
}

describe("Field", () => {
  test("the label's htmlFor equals the control's id, and the description is linked", () => {
    const html = renderToStaticMarkup(
      <Field controlId="x-1">
        <FieldLabel>Title</FieldLabel>
        <Control />
      </Field>,
    );
    expect(html).toContain('for="x-1"');
    expect(html).toContain('id="x-1"');
    expect(html).toContain('aria-describedby="x-1-description"');
    expect(html).not.toContain("aria-invalid");
  });
  test("an invalid field marks the control and links the error", () => {
    const html = renderToStaticMarkup(
      <Field controlId="x-2" invalid>
        <FieldLabel>Branch name</FieldLabel>
        <Control />
        <FieldError>Bad name</FieldError>
      </Field>,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="x-2-description x-2-error"');
    expect(html).toContain('role="alert"');
  });
});

describe("Picker", () => {
  const items = [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta", disabled: true }];
  test("the closed trigger is a native listbox button with no popover marker", () => {
    const html = renderToStaticMarkup(<Picker value="a" onChange={() => {}} items={items} testId="p" id="p-id" />);
    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-testid="p-trigger"');
    expect(html).toContain('data-value="a"');
    expect(html).toContain('id="p-id"');
    expect(html).not.toContain("data-popover-open");
    expect(html).not.toContain("<select");
  });
  test("shows the placeholder when nothing is selected", () => {
    const html = renderToStaticMarkup(<Picker value={null} onChange={() => {}} items={items} placeholder="Pick one" />);
    expect(html).toContain("Pick one");
  });
  test("inside a disabled fieldset the trigger is still a native button (the fieldset disables it)", () => {
    const html = renderToStaticMarkup(
      <fieldset disabled>
        <Picker value="a" onChange={() => {}} items={items} />
      </fieldset>,
    );
    expect(html).toMatch(/<fieldset disabled=""[^>]*><div[^>]*><button type="button"/);
  });
  test("a disabled picker disables its trigger", () => {
    const html = renderToStaticMarkup(<Picker value="a" onChange={() => {}} items={items} disabled />);
    expect(html).toMatch(/<button[^>]*disabled=""/);
  });
});

describe("SegmentedControl", () => {
  const items = [{ value: "x", label: "X", testId: "seg-x" }, { value: "y", label: "Y", testId: "seg-y" }];
  test("renders a radiogroup whose radios carry aria-checked, and only the checked one is tabbable", () => {
    const html = renderToStaticMarkup(<SegmentedControl value="y" onChange={() => {}} items={items} aria-label="Kind" testId="seg" />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Kind"');
    expect(html.match(/role="radio"/g)?.length).toBe(2);
    expect(html).toMatch(/aria-checked="false"[^>]*tabindex="-1"/);
    expect(html).toMatch(/aria-checked="true"[^>]*tabindex="0"/);
  });
  test("the selected style is subtle: never a filled primary", () => {
    const html = renderToStaticMarkup(<SegmentedControl value="x" onChange={() => {}} items={items} />);
    expect(html).toContain("bg-accent");
    expect(html).toContain("border-primary/60");
    expect(html).not.toContain("bg-primary ");
    expect(html).not.toContain('bg-primary"');
  });
  test("the first enabled radio is tabbable when nothing is selected", () => {
    const html = renderToStaticMarkup(<SegmentedControl value={null} onChange={() => {}} items={items} />);
    expect(html).toMatch(/tabindex="0"/);
  });
});

describe("Notice / Disclosure / ResizeHandle / Kbd", () => {
  test("a danger notice announces itself", () => {
    expect(renderToStaticMarkup(<Notice tone="danger">x</Notice>)).toContain('role="alert"');
    expect(renderToStaticMarkup(<Notice tone="muted">x</Notice>)).not.toContain('role="alert"');
  });
  test("a closed disclosure shows its note and links aria-controls; an open one renders the region", () => {
    const closed = renderToStaticMarkup(
      <Disclosure open={false} onOpenChange={() => {}} label="More options" note="Speed: Fast" testId="more">body</Disclosure>,
    );
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain("Speed: Fast");
    expect(closed).not.toContain("body");
    const open = renderToStaticMarkup(
      <Disclosure open onOpenChange={() => {}} label="More options" note="Speed: Fast" testId="more">body</Disclosure>,
    );
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("body");
    expect(open).not.toContain("Speed: Fast");
    const id = /aria-controls="([^"]+)"/.exec(open)![1]!;
    expect(open).toContain(`id="${id}"`);
  });
  test("the resize handle is a focusable vertical separator with its value", () => {
    const html = renderToStaticMarkup(
      <ResizeHandle value={384} min={320} max={560} onChange={() => {}} onCommit={() => {}} onReset={() => {}} label="Resize" testId="rh" />,
    );
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-valuenow="384"');
    expect(html).toContain('aria-valuemin="320"');
    expect(html).toContain('aria-valuemax="560"');
    expect(html).toContain('tabindex="0"');
  });
  test("Kbd renders a kbd element", () => {
    expect(renderToStaticMarkup(<Kbd aria-hidden>⌘↵</Kbd>)).toContain("<kbd");
  });
});

describe("Dialog parts", () => {
  test("compose as children of the panel, the body being the only scroll region", () => {
    // Dialog renders nothing while closed; parts are checked standalone.
    const html = renderToStaticMarkup(
      <div>
        <DialogHeader><DialogTitle id="t">Title</DialogTitle></DialogHeader>
        <DialogBody>body</DialogBody>
        <DialogFooter>foot</DialogFooter>
      </div>,
    );
    expect(html).toContain("overflow-y-auto");
    expect(html.match(/overflow-y-auto/g)?.length).toBe(1);
    expect(html).toContain('id="t"');
    expect(html).toContain("shrink-0");
    expect(renderToStaticMarkup(<Dialog open={false} onClose={() => {}}>x</Dialog>)).toBe("");
  });
});
