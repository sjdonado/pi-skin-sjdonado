#!/usr/bin/env sh
# Installs pi-durable: the custom Pi Durable coding harness.
#
#   curl -fsSL https://raw.githubusercontent.com/sjdonado/pi-durable/main/install.sh | sh
#
# Clones (or fast-forward updates) the repo into $PI_DURABLE_DIR
# (default $HOME/Development/pi-durable), installs dependencies with Bun,
# and links pi into $HOME/.local/bin. Needs: git, bun, Pi subscription login
# (via pi-agent /login). pi-agent itself stays the package-manager-owned
# upstream binary and is resolved at runtime, never moved.
set -eu
DIR="${PI_DURABLE_DIR:-$HOME/Development/pi-durable}"
BIN_DIR="${HOME}/.local/bin"
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }
if [ ! -d "$DIR/.git" ]; then
  git clone https://github.com/sjdonado/pi-durable.git "$DIR"
else
  git -C "$DIR" pull --ff-only
fi
bun install --ignore-scripts --no-save --cwd "$DIR"
mkdir -p "$BIN_DIR"
ln -snf "$DIR/bin/pi" "$BIN_DIR/pi"
echo "Installed pi from $DIR. Run: pi --check"
echo "Upstream Pi stays untouched; pi-agent resolves it at runtime."
