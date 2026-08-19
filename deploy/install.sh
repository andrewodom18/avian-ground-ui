#!/usr/bin/env bash
set -euo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

usage() {
    cat <<'EOF'
Usage: sudo deploy/install.sh [--bin-dir PATH] [--assets-dir PATH] [--enable]

Without prebuilt paths, the installer creates a locked Rust release build and
exports the web assets with Node.js 22.13 or newer. AVIAN must already be
installed so the dedicated avian service account and control socket exist.
EOF
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
BIN_SOURCE=""
ASSETS_SOURCE=""
ENABLE_SERVICE=0
ASSETS_STAGE=""
ASSETS_BACKUP=""
RESTART_SERVICE=0

remove_install_tree() {
    local target="$1"
    case "$target" in
        /usr/local/share/avian-ground-ui|/usr/local/share/.avian-ground-ui.*)
            rm -rf -- "$target"
            ;;
        *)
            printf 'Refusing to remove unexpected path: %s\n' "$target" >&2
            return 1
            ;;
    esac
}

cleanup() {
    local exit_code=$?
    if [[ -n "$ASSETS_STAGE" && -d "$ASSETS_STAGE" ]]; then
        remove_install_tree "$ASSETS_STAGE" || true
    fi
    if [[ -n "$ASSETS_BACKUP" && -e "$ASSETS_BACKUP" ]]; then
        if [[ -e /usr/local/share/avian-ground-ui ]]; then
            remove_install_tree /usr/local/share/avian-ground-ui || true
        fi
        mv -- "$ASSETS_BACKUP" /usr/local/share/avian-ground-ui || true
        ASSETS_BACKUP=""
    fi
    if ((RESTART_SERVICE)); then
        systemctl start avian-ground-ui.service >/dev/null 2>&1 || true
    fi
    exit "$exit_code"
}

trap cleanup EXIT

while (($#)); do
    case "$1" in
        --bin-dir)
            [[ $# -ge 2 ]] || { usage >&2; exit 2; }
            BIN_SOURCE="$2"
            shift 2
            ;;
        --assets-dir)
            [[ $# -ge 2 ]] || { usage >&2; exit 2; }
            ASSETS_SOURCE="$2"
            shift 2
            ;;
        --enable)
            ENABLE_SERVICE=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            printf 'Unknown argument: %s\n' "$1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

[[ "$(uname -s)" == "Linux" ]] || { printf 'AVIAN ground dashboard installation requires Linux.\n' >&2; exit 1; }
[[ "$EUID" -eq 0 ]] || { printf 'Run this installer as root.\n' >&2; exit 1; }
id -u avian >/dev/null 2>&1 || { printf 'Install AVIAN before the ground dashboard.\n' >&2; exit 1; }
getent group systemd-journal >/dev/null || { printf 'The systemd-journal group is required for bounded AVIAN log reads.\n' >&2; exit 1; }

if [[ -z "$BIN_SOURCE" ]]; then
    command -v cargo >/dev/null || { printf 'cargo is required when --bin-dir is omitted.\n' >&2; exit 1; }
    cargo build --manifest-path "$REPO_ROOT/Cargo.toml" --release --locked
    BIN_SOURCE="$REPO_ROOT/target/release"
fi

if [[ -z "$ASSETS_SOURCE" ]]; then
    command -v node >/dev/null || { printf 'Node.js 22.13 or newer is required when --assets-dir is omitted.\n' >&2; exit 1; }
    node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<13))process.exit(1)' || {
        printf 'Node.js 22.13 or newer is required.\n' >&2
        exit 1
    }
    command -v npm >/dev/null || { printf 'npm is required when --assets-dir is omitted.\n' >&2; exit 1; }
    (cd "$REPO_ROOT" && npm ci && npm run export:ground)
    ASSETS_SOURCE="$REPO_ROOT/ground-dist"
fi

[[ -f "$BIN_SOURCE/avian-ground-ui" && ! -L "$BIN_SOURCE/avian-ground-ui" && -x "$BIN_SOURCE/avian-ground-ui" ]] || { printf 'Missing regular executable: %s/avian-ground-ui\n' "$BIN_SOURCE" >&2; exit 1; }
[[ -d "$ASSETS_SOURCE" && ! -L "$ASSETS_SOURCE" ]] || { printf 'Assets must be a regular directory: %s\n' "$ASSETS_SOURCE" >&2; exit 1; }
[[ -f "$ASSETS_SOURCE/index.html" && ! -L "$ASSETS_SOURCE/index.html" ]] || { printf 'Missing regular dashboard index: %s/index.html\n' "$ASSETS_SOURCE" >&2; exit 1; }
[[ -d "$ASSETS_SOURCE/_next" ]] || { printf 'Missing dashboard assets: %s/_next\n' "$ASSETS_SOURCE" >&2; exit 1; }
if find "$ASSETS_SOURCE" -mindepth 1 ! -type d ! -type f -print -quit | grep -q .; then
    printf 'Dashboard assets may contain only regular files and directories.\n' >&2
    exit 1
fi

install -d -m 0755 -o root -g root /usr/local/bin /usr/local/share
install -m 0755 -o root -g root "$BIN_SOURCE/avian-ground-ui" /usr/local/bin/avian-ground-ui
ASSETS_STAGE="$(mktemp -d /usr/local/share/.avian-ground-ui.XXXXXX)"
cp -a "$ASSETS_SOURCE/." "$ASSETS_STAGE/"
[[ -f "$ASSETS_STAGE/index.html" && ! -L "$ASSETS_STAGE/index.html" && -d "$ASSETS_STAGE/_next" ]] || {
    printf 'Staged dashboard assets are incomplete.\n' >&2
    exit 1
}
if find "$ASSETS_STAGE" -mindepth 1 ! -type d ! -type f -print -quit | grep -q .; then
    printf 'Staged dashboard assets may contain only regular files and directories.\n' >&2
    exit 1
fi
chown -R root:root "$ASSETS_STAGE"
find "$ASSETS_STAGE" -type d -exec chmod 0755 {} +
find "$ASSETS_STAGE" -type f -exec chmod 0644 {} +

if systemctl is-active --quiet avian-ground-ui.service; then
    RESTART_SERVICE=1
    systemctl stop avian-ground-ui.service
fi
if [[ -e /usr/local/share/avian-ground-ui ]]; then
    ASSETS_BACKUP="$(mktemp -d /usr/local/share/.avian-ground-ui.backup.XXXXXX)"
    rmdir "$ASSETS_BACKUP"
    mv -- /usr/local/share/avian-ground-ui "$ASSETS_BACKUP"
fi
mv -- "$ASSETS_STAGE" /usr/local/share/avian-ground-ui
ASSETS_STAGE=""
install -m 0644 -o root -g root "$SCRIPT_DIR/avian-ground-ui.service" \
    /etc/systemd/system/avian-ground-ui.service

systemctl daemon-reload
if ((ENABLE_SERVICE)); then
    systemctl enable --now avian-ground-ui.service
    RESTART_SERVICE=0
    printf 'AVIAN Ground is available at http://127.0.0.1:4178/ on this device.\n'
elif ((RESTART_SERVICE)); then
    systemctl start avian-ground-ui.service
    RESTART_SERVICE=0
    printf 'Updated and restarted avian-ground-ui.service.\n'
else
    printf 'Installed but not enabled. Run systemctl enable --now avian-ground-ui.service when ready.\n'
fi

if [[ -n "$ASSETS_BACKUP" ]]; then
    remove_install_tree "$ASSETS_BACKUP"
    ASSETS_BACKUP=""
fi
trap - EXIT
