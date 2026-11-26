# Security policy

## Reporting a vulnerability

Please report a security problem privately, not in a public issue or pull request.

Use GitHub's private vulnerability reporting on this repository: **Security → Report a vulnerability**. Include what you found, the version or commit, and the steps to reproduce it. A proof of concept helps; please do not run it against anyone else's machine or account.

You can expect an acknowledgement, a fix or a written reason it is not one, and credit if you want it. Please give us time to ship a fix before you disclose.

## What is in scope

- The Agetor app and its local API (the two per-launch tokens, the route policy, the CLI path gate).
- The Agetor Companion's Mac side: pairing, the Noise session, signed decisions, the key helper, the relay link and the phone terminal. The design and its invariants are in [`docs/architecture/security.md`](docs/architecture/security.md) and [`docs/architecture/remote-gateway.md`](docs/architecture/remote-gateway.md).

Agents run with the user's full shell privileges in the task's directory. There is no sandbox, and that is documented behaviour, not a vulnerability.

## Supported versions

Only the latest release receives security fixes.
