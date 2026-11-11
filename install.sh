#!/bin/sh
set -eu

RELEASE_URL="${RPG_RELEASE_URL:-https://github.com/dreuse/rpg-harness/releases/latest/download}"
INSTALL_DIR="$HOME/.local/share/rpg-harness"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/rpg"

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$INSTALL_DIR" "$LAUNCHER"
  echo "Removed rpg. Campaigns stay in your data folder."
  exit 0
fi

case "$(uname -s)" in
  Darwin) platform=darwin binary="RPG Harness.app/Contents/MacOS/RPG Harness" app="RPG Harness.app/Contents/Resources/app" ;;
  Linux) platform=linux binary=rpg-harness app=resources/app ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
curl -fsSL -o "$staging/rpg.tar.gz" "$RELEASE_URL/rpg-harness-$platform-$arch.tar.gz"
tar -xzf "$staging/rpg.tar.gz" -C "$staging"
extracted="$staging/RPG Harness-$platform-$arch"
test -x "$extracted/$binary"

rm -rf "$INSTALL_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR"
mv "$extracted" "$INSTALL_DIR"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "$INSTALL_DIR/$binary" "$INSTALL_DIR/$app/apps/cli/src/bin.ts" "\$@"
EOF
chmod +x "$LAUNCHER"
echo "Installed rpg to $LAUNCHER"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add $BIN_DIR to your PATH." ;;
esac
