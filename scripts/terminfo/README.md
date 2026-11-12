# Vendored terminfo database

Agetor's bundled tmux (`vendor/tmux/arm64/tmux`, copied to
`Contents/Resources/app/bin/tmux` in the packaged app) links a vendored
`libncursesw.6.dylib`. That library's compiled-in default terminfo directory is
the **build machine's** Homebrew Cellar path
(`/opt/homebrew/Cellar/ncurses/<version>/share/terminfo`), which does not exist
on a user's Mac when Homebrew ncurses is absent, is a different Cellar version,
or was upgraded after Agetor was built. A headless tmux client (no tty) never
resolves terminfo, so Agetor's own commands keep working — but attaching a real
terminal to a session (`Open in Terminal`) gives tmux a tty and it dies with
`can't find terminfo database` before the shell starts (issue #298).

This directory therefore ships the five entries Terminal.app / tmux clients
need, copied from the macOS system database at `/usr/share/terminfo` in its
hashed layout:

| Entry | System source |
| --- | --- |
| `xterm-256color` | `/usr/share/terminfo/78/xterm-256color` |
| `xterm` | `/usr/share/terminfo/78/xterm` |
| `screen` | `/usr/share/terminfo/73/screen` |
| `screen-256color` | `/usr/share/terminfo/73/screen-256color` |
| `tmux-256color` | `/usr/share/terminfo/74/tmux-256color` |

At runtime the bundled-binary search path puts this directory first and
`/usr/share/terminfo` second (`TERMINFO_DIRS`), so a custom `TERM` still
resolves whenever the OS database has it.

The entry files are ncurses terminfo data. Their license is the ncurses
license, reproduced verbatim in `LICENSE-ncurses.txt` beside this file.

**Generated, never hand-edited.** `bun run vendor:tmux`
(`scripts/fetch-tmux.ts`) copies the entries plus this notice, the license, and
a `PROVENANCE.txt` recording the source path and timestamp. Re-run it on the
build host to regenerate; the output lives in the gitignored `vendor/` tree and
is copied into the app bundle by `electrobun.config.ts`.
