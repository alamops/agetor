#!/bin/sh
# Agetor CLI installer.  Usage:
#   curl -fsSL https://github.com/alamops/agetor/releases/latest/download/install.sh | sh
set -eu

REPO="alamops/agetor"
ASSET="agetor-arm64"
BASE="https://github.com/${REPO}/releases/latest/download"

red() { printf '\033[31m%s\033[0m\n' "$1"; }
grn() { printf '\033[32m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }

# ── platform gate ──────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" != "Darwin" ] || [ "$ARCH" != "arm64" ]; then
  red "Agetor's CLI ships for arm64 macOS only."
  echo "  (Cross-compiling is fragile and the Intel/Linux audience is small.)"
  echo "  Use the desktop app, or build from source: https://github.com/${REPO}"
  exit 1
fi

for tool in curl shasum; do
  command -v "$tool" >/dev/null 2>&1 || { red "missing required tool: $tool"; exit 1; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

dim "downloading ${ASSET}…"
curl -fL --proto '=https' --tlsv1.2 "${BASE}/${ASSET}" -o "$TMP/agetor"

# ── checksum (required — a missing one signals a tampered/partial release) ──
if ! curl -fsL "${BASE}/${ASSET}.sha256" -o "$TMP/agetor.sha256"; then
  red "could not fetch ${ASSET}.sha256 — refusing to install unverified"
  exit 1
fi
expected="$(awk '{print $1}' "$TMP/agetor.sha256")"
actual="$(shasum -a 256 "$TMP/agetor" | awk '{print $1}')"
if [ "$expected" != "$actual" ]; then
  red "checksum mismatch — refusing to install"
  echo "  expected $expected"
  echo "  actual   $actual"
  exit 1
fi
dim "checksum ok"

chmod +x "$TMP/agetor"
# curl usually doesn't set the quarantine xattr, but strip it defensively so a
# browser-downloaded copy never trips Gatekeeper.
xattr -d com.apple.quarantine "$TMP/agetor" 2>/dev/null || true

# ── choose an install dir ──────────────────────────────────────────────────
DEST_DIR="/usr/local/bin"
if [ -w "$DEST_DIR" ] || { [ ! -e "$DEST_DIR" ] && [ -w "$(dirname "$DEST_DIR")" ]; }; then
  mkdir -p "$DEST_DIR"
  mv "$TMP/agetor" "$DEST_DIR/agetor"
elif command -v sudo >/dev/null 2>&1 && [ -t 0 ]; then
  dim "installing to $DEST_DIR (needs sudo)…"
  sudo mkdir -p "$DEST_DIR"
  sudo mv "$TMP/agetor" "$DEST_DIR/agetor"
else
  DEST_DIR="$HOME/.local/bin"
  mkdir -p "$DEST_DIR"
  mv "$TMP/agetor" "$DEST_DIR/agetor"
fi
DEST="$DEST_DIR/agetor"
grn "installed → $DEST"

# ── verify ─────────────────────────────────────────────────────────────────
if "$DEST" --version >/dev/null 2>&1; then
  dim "version $("$DEST" --version)"
else
  red "installed, but '$DEST --version' failed to run"
fi

# ── PATH + shadow hints ────────────────────────────────────────────────────
case ":$PATH:" in
  *":$DEST_DIR:"*) : ;;
  *)
    echo
    echo "Add $DEST_DIR to your PATH (then restart your shell):"
    echo "  export PATH=\"$DEST_DIR:\$PATH\""
    ;;
esac

existing="$(command -v agetor 2>/dev/null || true)"
if [ -n "$existing" ] && [ "$existing" != "$DEST" ]; then
  echo
  dim "note: another 'agetor' on PATH at $existing may shadow $DEST"
fi

echo
grn "done — run 'agetor' for the dashboard, or 'agetor add' to create a task."
