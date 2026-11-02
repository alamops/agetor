# Test seams: native pickers and downloads

> Moved from `CLAUDE.md`, where this was the `POST /refs/pick` bullet of “Things that will trip you up”. Index of all subsystem docs: the [Topic map in CLAUDE.md](../../CLAUDE.md#topic-map).

`POST /refs/pick` opens a native open-panel and answers "not available" in the headless backend — the Playwright harness has no native bridge.
`AGETOR_FAKE_PICK_REFS_DIR=<dir>` is the test seam (same spirit as `AGETOR_*_DRIVER=fake`, env wins whenever set): mode `files` returns that directory's immediate regular files, mode `folder` returns the directory itself, a missing dir reads as a cancelled pick.
`e2e/fixtures.ts` creates `<dataDir>/fake-picks`, sets the env and exposes it as `backend.fakePickDir` — write the files a spec wants "picked" there, then click `refs-pick-files`/`refs-pick-folder` — always scoped to the container (the dialog or the run panel): the New Task panel's expandable picker and RunPanel's inline picker are mounted at the same time and share the inner ids (`refs-pick-*`, `refs-chip`, `refs-remove`); only the roots are variant-specific (`refs-dropzone-expandable` / `refs-dropzone-inline`).
Drops are drivable without a seam (a `text/uri-list` of `file://` URLs dispatched on `refs-dropzone`), but `capture-refs.ts`'s `isTransientPath` filters `/tmp` and `/var/folders`, so a dropped fixture file must live outside the temp dirs (the repo checkout works).
The [bundle](bundle.md) routes reuse the same seam — `/bundle/export/save` with `target: "folder"` writes into that directory and `/bundle/pick-file` returns its first `*.json` file (name order) — and add `AGETOR_DOWNLOADS_DIR=<dir>` for Save to Downloads (`e2e/fixtures.ts` points it at `<dataDir>/fake-downloads`, exposed as `backend.downloadsDir`).
A bundle drop needs no seam: the drop handler reads the dropped `File` with `File.text()`.
