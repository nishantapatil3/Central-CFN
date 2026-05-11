# CFN Integration for Claude Code

Bidirectional CFN (Cognitive Fabric Node) integration for Claude Code - queries shared memory before agent runs and writes conversations back after completion.

## Features

### Read (Query Before Agent Runs)
- **Hook**: `UserPromptSubmit`
- Queries CFN's shared-memories before the agent processes your message
- Injects relevant context from past conversations into the system prompt
- Agent can reference information from other sessions/agents

### Write (Capture After Completion)
- **Hook**: `Stop`
- Writes completed conversation turns to CFN after agent finishes
- Captures: user message, thinking, tool calls, and response
- Makes your conversations searchable and available to other agents

## Installation

### 1. Copy Plugin to Claude Plugins Directory

```bash
# Create Claude plugins directory if it doesn't exist
mkdir -p ~/.claude/plugins

# Copy this plugin
cp -r ~/cfn-claude-code ~/.claude/plugins/

# Make hook scripts executable
chmod +x ~/.claude/plugins/cfn-claude-code/hooks/*.py
```

### 2. Configure the Plugin

```bash
# Copy sample config
cd ~/cfn-claude-code
cp config.json.sample config.json

# Edit config with your CFN details
nano config.json
```

Required configuration:
```json
{
  "cfn_node_url": "http://your-cfn-host:9002",
  "workspace_id": "your-workspace-uuid",
  "mas_id": "your-mas-uuid",
  "agent_id": "claude-code",
  "enabled": true
}
```

### 3. Register Hooks in Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.claude/plugins/cfn-claude-code/hooks/cfn-query.py",
            "timeout": 60
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.claude/plugins/cfn-claude-code/hooks/cfn-write.py",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `cfn_node_url` | - | CFN service URL (required) |
| `workspace_id` | - | Workspace UUID (required) |
| `mas_id` | - | Multi-Agentic System UUID (required) |
| `agent_id` | `"claude-code"` | Agent identifier |
| `enabled` | `false` | Master enable/disable switch |
| `query_timeout` | `60` | CFN query timeout (seconds) |
| `write_timeout` | `30` | CFN write timeout (seconds) |
| `min_query_length` | `10` | Minimum chars to trigger query |
| `max_text_bytes` | `8192` | Max bytes for text content |
| `max_tool_bytes` | `4096` | Max bytes for tool content |

## How It Works

### Query Flow (UserPromptSubmit Hook)

```
User types message
      ↓
UserPromptSubmit hook fires
      ↓
Query CFN with user's message
      ↓
CFN returns relevant context (if any)
      ↓
Inject context into system prompt
      ↓
Agent processes message with context
```

### Write Flow (Stop Hook)

```
Agent completes response
      ↓
Stop hook fires
      ↓
Read session transcript
      ↓
Extract last complete turn
      ↓
Write to CFN shared-memories
```

## Example Usage

### Query Example

**User asks**: "What event is on April 25th 2026?"

**CFN returns**: "Ramesh and Suresh are travelling to San Diego on April 24th, 2026"

**Agent sees**:
```
## Relevant Context from Central CFN

The following information was retrieved from the shared memory system 
and may be relevant to the user's query:

Ramesh and Suresh are travelling to San Diego on April 24th, 2026

---

User: What event is on April 25th 2026?
```

**Agent can now answer** using context from a different conversation!

### Write Example

After agent completes, this is written to CFN:
```
Session: abc123-session-id
CWD: /home/user/project
Model: claude-sonnet-4-6
Timestamp: 2026-04-20T23:00:00Z

User: What event is on April 25th 2026?

Thinking: Based on the context, this is likely day 2 of their San Diego trip