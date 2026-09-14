/*
 * disclaim — exec a command as TCC-responsible for itself, instead of
 * inheriting the caller's ("responsible process") identity.
 *
 * Why: macOS's TCC (Transparency, Consent & Control) attributes a spawned
 * child's data-access prompts (e.g. kTCCServiceSystemPolicyAppData, "would
 * like to access data from other apps") to whichever ancestor is marked the
 * *responsible process* — by default, the process that called posix_spawn/
 * fork+exec. When Agetor (a signed, notarized app) spawns tmux, which in
 * turn hosts `claude`/`codex`/etc., every one of those descendants inherits
 * Agetor's responsibility. So when claude (or an MCP/plugin it loads) reads
 * another app's Application Support directory, the OS prompts "Agetor would
 * like to access data from other apps" — never the actual accessing binary
 * — and because the *responsible identity* (Agetor) differs from the
 * *accessing binary* (claude), the resulting grant never persists; the user
 * re-prompted on every launch.
 *
 * The fix is the private `responsibility_spawnattrs_setdisclaim` posix_spawn
 * attribute: it tells the kernel "the process I'm about to exec is
 * responsible for itself," so the prompt (if any) names the real accessor
 * and its grant persists like any ordinary app's. This is not a novel
 * technique — Anthropic's own Claude Desktop ships an equivalent
 * `disclaimer` helper for the same reason, and torarnv/disclaim
 * (https://github.com/torarnv/disclaim) is the commonly-cited reference
 * implementation this file mirrors. The symbol is undocumented/private (no
 * public header), so it's declared here and resolved weakly — if a future
 * macOS drops it, this helper still runs the command, just without the
 * disclaim (fail-open, never fail-closed).
 *
 * We use POSIX_SPAWN_SETEXEC so posix_spawnp() replaces *this* process's own
 * image in place (like execve) rather than forking a new one — no lingering
 * wrapper process, and the target inherits our pid and already-inherited
 * stdio file descriptors exactly as if it had been exec'd directly.
 */

#include <spawn.h>
#include <stdio.h>
#include <errno.h>
#include <string.h>

extern char **environ;

/* Undocumented private symbol; resolve weakly so a future OS without it
 * still lets the command run (just without the disclaim). Signature per
 * LLDB's PosixSpawnResponsible.h. */
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim) __attribute__((weak_import));

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: disclaim <command> [args...]\n");
        return 2;
    }

    posix_spawnattr_t attr;
    if (posix_spawnattr_init(&attr) != 0) {
        perror("posix_spawnattr_init");
        return 1;
    }
    posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETEXEC);
    if (responsibility_spawnattrs_setdisclaim) {
        responsibility_spawnattrs_setdisclaim(&attr, 1);
    }

    /* &argv[1] deliberately makes the target command its own argv[0]. With
     * POSIX_SPAWN_SETEXEC, posix_spawnp only returns on failure — success
     * replaces this process image outright. */
    int rc = posix_spawnp(NULL, argv[1], NULL, &attr, &argv[1], environ);
    fprintf(stderr, "disclaim: exec %s failed: %s\n", argv[1], strerror(rc ? rc : errno));
    posix_spawnattr_destroy(&attr);
    return 127;
}
