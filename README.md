# Central-CFN

Central repository for CFN (Claude Function Network) hooks and MCP servers.

## Structure

```
├── hooks/           # Claude Code hooks
│   ├── claude-read-write/
│   └── openclaw-read-write/
├── mcp/             # MCP servers
│   ├── claude-read/
│   └── openclaw-read/
```

## Hooks

- **claude-read-write** — Hook for querying and writing CFN data via Claude Code.
- **openclaw-read-write** — Hook for reading and writing via OpenClaw.

## MCP Servers

- **claude-read** — MCP server for reading CFN data.
- **openclaw-read** — MCP server for reading OpenClaw data.
