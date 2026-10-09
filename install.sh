#!/usr/bin/env sh
# Installs pi-skin-sjdonado: my skin for running a harness in Pi.
#
#   curl -fsSL https://raw.githubusercontent.com/sjdonado/pi-skin-sjdonado/main/install.sh | sh
#
# Clones (or shallow-syncs main of) the repo into $PI_SKIN_DIR
# (default $HOME/Developer/pi-skin-sjdonado), installs dependencies with Bun,
# and links pss into $HOME/.local/bin. Needs: git, bun, and pi itself
# installed, configured and logged in. The upstream Pi binary stays
# package-manager-owned and is resolved at runtime, never moved.
set -eu
DIR="${PI_SKIN_DIR:-$HOME/Developer/pi-skin-sjdonado}"
BIN_DIR="${HOME}/.local/bin"
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }
command -v pi >/dev/null || { echo "pi is required: install and log in with pi first" >&2; exit 1; }
if [ ! -d "$DIR/.git" ]; then
  git clone --depth 1 --branch main https://github.com/sjdonado/pi-skin-sjdonado.git "$DIR"
else
  git -C "$DIR" fetch --depth 1 origin main
  git -C "$DIR" checkout -q -B main FETCH_HEAD
fi
bun install --ignore-scripts --no-save --cwd "$DIR"
mkdir -p "$BIN_DIR"
ln -snf "$DIR/bin/pss" "$BIN_DIR/pss"
echo "Installed pss from $DIR. Run: pss --check"
