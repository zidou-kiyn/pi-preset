#!/usr/bin/env bash
#
# Secret scan for the pi-preset repository (AC6).
#
# Scans the working tree (tracked + untracked-but-not-ignored files) and, when
# the repository already has commits, the full history via `git log -p`.
#
# Scanner implementation files are excluded from BOTH scans: they necessarily
# contain every pattern they look for and would otherwise match themselves.
#
# Exit 0 = clean, exit 1 = at least one hit.

set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root" || exit 2

self_rel="scripts/scan-secrets.sh"
scanner_rel="scripts/scan-secrets.mjs"
status=0

echo "== working tree =="
files=()
while IFS= read -r -d '' f; do
	[ "$f" = "$self_rel" ] && continue
	[ "$f" = "$scanner_rel" ] && continue
	[ -f "$f" ] || continue
	files+=("$f")
done < <(git ls-files --cached --others --exclude-standard -z)

if [ "${#files[@]}" -eq 0 ]; then
	echo "no files to scan"
else
	if printf '%s\0' "${files[@]}" | node "$scanner_rel" --files; then
		echo "clean (${#files[@]} files)"
	else
		echo "FAIL: secret pattern found in working tree"
		status=1
	fi
fi

echo
echo "== history =="
if ! git rev-parse --verify -q HEAD >/dev/null; then
	echo "no commits yet, skipping"
else
	if git log -p --all -- . ":(exclude)$self_rel" ":(exclude)$scanner_rel" | node "$scanner_rel" --stream git-history; then
		echo "clean"
	else
		echo "FAIL: secret pattern found in git history"
		status=1
	fi
fi

echo
if [ "$status" -eq 0 ]; then
	echo "RESULT: clean"
else
	echo "RESULT: FAILED"
fi
exit "$status"
