#!/usr/bin/env bash
#
# Secret scan for the pi-preset repository (AC6).
#
# Scans the working tree (tracked + untracked-but-not-ignored files) and, when
# the repository already has commits, the full history via `git log -p`.
#
# This script excludes itself from BOTH scans: it necessarily contains every
# pattern it looks for, and its own diff would otherwise match in history.
#
# Exit 0 = clean, exit 1 = at least one hit.

set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root" || exit 2

self_rel="scripts/scan-secrets.sh"

# Patterns that must never appear in a public artifact.
patterns=(
	'sk-[A-Za-z0-9_-]{20,}'
	'heixiaohu'
	'anyrouter'
	'sub2api'
	'127\.0\.0\.1:8317'
	'"apiKey"'
)

joined=""
for p in "${patterns[@]}"; do
	if [ -z "$joined" ]; then joined="$p"; else joined="$joined|$p"; fi
done

status=0

echo "== working tree =="
files=()
while IFS= read -r -d '' f; do
	[ "$f" = "$self_rel" ] && continue
	[ -f "$f" ] || continue
	files+=("$f")
done < <(git ls-files --cached --others --exclude-standard -z)

if [ "${#files[@]}" -eq 0 ]; then
	echo "no files to scan"
else
	if grep -nIEH "$joined" -- "${files[@]}"; then
		echo "FAIL: secret pattern found in working tree"
		status=1
	else
		echo "clean (${#files[@]} files)"
	fi
fi

echo
echo "== history =="
if ! git rev-parse --verify -q HEAD >/dev/null; then
	echo "no commits yet, skipping"
elif git log -p --all -- . ":(exclude)$self_rel" | grep -nE "$joined"; then
	echo "FAIL: secret pattern found in git history"
	status=1
else
	echo "clean"
fi

echo
if [ "$status" -eq 0 ]; then
	echo "RESULT: clean"
else
	echo "RESULT: FAILED"
fi
exit "$status"
