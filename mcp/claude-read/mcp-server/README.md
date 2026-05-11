# CFN Memory MCP Server

This MCP server exposes your CFN (Collaborative Function Network) shared-memories as a tool that Claude Code can call directly.

## What This Does

- **Wraps your existing CFN API** - No changes needed to the CFN server
- **Exposes `query_cfn_memory` tool** - Claude can proactively query CFN when needed
- **More transparent** - Shows up as a visible tool call in the conversation
- **Better than hooks** - Works reliably (unlike the `prependContext` hook bug)

## Setup

Everything is already configured! The MCP server is registered in `~/.mcp.json`.

## How to Use

### Start a New Claude Code Session

The MCP server connects automatically when you start Claude Code. You should see it in the startup logs.

### Query CFN Memory

Just ask Claude questions that might be in CFN's memory:

```bash
# Claude will automatically use the query_cfn_memory tool when appropriate
"Can you tell me about the atlas project incident today?"
"What decisions were made about the authentication system?"
"What's the status of the backend migration?"
```

### Enable the Server (if needed)

On first use, Claude Code may ask you to approve the `cfn-memory` MCP server. Click "Allow" or "Enable" in the UI.

## Configuration

The server reads from your existing config at:
```
~/cfn-claude-code/config.json
```

To enable/disable queries, edit:
```json
{
  "read_enabled": true,   // Enable queries
  "write_enabled": false  // Keep write disabled for now
}
```

## Logging

Logs are written to:
```
~/cfn-claude-code/logs/cfn-mcp.log
```

Check this file if queries aren't working as expected.

## Architecture

```
┌─────────────┐
│ Claude Code │
└──────┬──────┘
       │ MCP Protocol
       ↓
┌─────────────────┐
│ CFN MCP Server  │  (Python, this directory)
│ - query_cfn_... │
└────────┬────────┘
         │ HTTP
         ↓
┌─────────────────┐
│ CFN Backend API │  (Your existing server, unchanged)
│ nispatil-m-qlpj │
└─────────────────┘
```

## Troubleshooting

### Server not starting
Check that the virtual environment is set up:
```bash
ls ~/cfn-claude-code/mcp-server/venv/
```

### Tool not showing up
1. Check `~/.mcp.json` exists and has the `cfn-memory` entry
2. Restart Claude Code
3. Look for MCP connection errors in Claude Code startup

### Queries returning no results
1. Check that `read_enabled: true` in `~/cfn-claude-code/config.json`
2. Verify CFN server is accessible: `curl http://nispatil-m-qlpj.local:9002`
3. Check logs: `tail -f ~/cfn-claude-code/logs/cfn-mcp.log`

## Files

- `cfn_mcp_server.py` - Main MCP server code
- `run_server.sh` - Wrapper script that activates venv
- `venv/` - Python virtual environment with MCP SDK
- `README.md` - This file
