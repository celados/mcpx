#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUTFILE="dist/mcpx"
BUMP_KIND=""

usage() {
  cat <<'USAGE'
Usage: scripts/build.sh [--bump patch|minor|major] [--outfile PATH]

Build the mcpx Bun JS bundle.

Options:
  --bump KIND    Increment package.json version before building.
                 KIND must be patch, minor, or major.
  --outfile PATH Write the executable bundle to PATH. Default: dist/mcpx.
  -h, --help     Show this help.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bump)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --bump" >&2
        exit 1
      fi
      BUMP_KIND="$2"
      shift 2
      ;;
    --outfile)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --outfile" >&2
        exit 1
      fi
      OUTFILE="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -n "$BUMP_KIND" ]]; then
  case "$BUMP_KIND" in
    patch | minor | major) ;;
    *)
      echo "Invalid --bump value: $BUMP_KIND" >&2
      echo "Expected patch, minor, or major." >&2
      exit 1
      ;;
  esac

  BUMP_KIND="$BUMP_KIND" bun -e '
    const bumpKind = process.env.BUMP_KIND;
    const packageJson = await Bun.file("package.json").json();
    const current = packageJson.version;
    const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(current);

    if (!match) {
      throw new Error(`package.json version must be stable x.y.z, got ${current}`);
    }

    let major = Number(match[1]);
    let minor = Number(match[2]);
    let patch = Number(match[3]);

    // Bun.semver currently exposes order/satisfies, not increment. Keep bump
    // semantics explicit instead of guessing prerelease/build metadata rules.
    if (bumpKind === "major") {
      major += 1;
      minor = 0;
      patch = 0;
    } else if (bumpKind === "minor") {
      minor += 1;
      patch = 0;
    } else if (bumpKind === "patch") {
      patch += 1;
    } else {
      throw new Error(`Unsupported bump kind: ${bumpKind}`);
    }

    packageJson.version = `${major}.${minor}.${patch}`;
    await Bun.write("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
    console.log(`${current} -> ${packageJson.version}`);
  '
fi

VERSION="$(bun -e 'import packageJson from "./package.json" with { type: "json" }; console.log(packageJson.version);')"

OUTDIR="$(dirname "$OUTFILE")"
ENTRY_NAME="$(basename "$OUTFILE")"

mkdir -p "$OUTDIR"
rm -f "$OUTFILE" "$OUTFILE.map"
# The installer fetches one release asset, so linked maps make every installed
# invocation warn about a file that can never be present.
bun build ./src/main.ts \
  --target=bun \
  --format=esm \
  --minify \
  --outdir="$OUTDIR" \
  --entry-naming="$ENTRY_NAME"
chmod +x "$OUTFILE"

echo "Built mcpx v$VERSION at $OUTFILE"
