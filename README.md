# Central-CFN

Central repository for CFN (Cognitive Fabric Node) hooks and MCP servers.

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

- **claude-read-write** — Uses Claude Code hooks to read from and write to central CFN shared memory.
- **openclaw-read-write** — Uses OpenClaw plugin hooks to read from and write to central CFN shared memory.

## MCP Servers

- **claude-read** — Uses MCP to read from central CFN shared memory.
- **openclaw-read** — Uses MCP to read from central CFN shared memory via OpenClaw.
