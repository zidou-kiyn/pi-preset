# chrome-devtools-mcp

Only a version pin: `CHROME_DEVTOOLS_MCP_VERSION` in `src/manifest.ts`. No code is vendored.

## Check

- Compare the pin with `npm view chrome-devtools-mcp version`.
- If newer, read the changelog for: breaking changes, the flags and env we set, telemetry defaults, Node requirements.

## Carry over

- Bump the constant, and the version in `docs/mcp.md` and `docs/setup.md`.
- Adjust args or env if the changelog requires it.
