# CFN Enhanced Capture Plugin

This plugin provides bidirectional integration with CFN (Cognitive Fabric Node):

## Features

### 1. **Write to CFN** (Capture)
Captures comprehensive OpenClaw conversation data and sends it to CFN for knowledge extraction:
- Full LLM prompts and responses
- Tool call inputs and outputs
- Subagent conversations
- Inter-agent messages
- Usage statistics and metadata

### 2. **Read from CFN** (Enhancement)
Queries CFN before agent replies to inject relevant context from past conversations:
- Automatically extracts intent from agent replies
- Queries CFN's knowledge graph for relevant context
- Injects context as a "Relevant Context from Past Conversations" section
- Configurable via environment variables

## Files

- `cfn-enhanced-capture.ts` - Enhanced plugin with bidirectional CFN integration (write + read)
- `openclaw.plugin.json` - Plugin manifest
- `README.md` - This documentation

## Configuration

### Environment Variables

```bash
# Required
CFN_NODE_URL=http://nispatil-m-qlpj.local:9002
WORKSPACE_ID=f968acc3-640b-4bb3-95ad-7d2a3a72a399
MAS_ID=cfc3c6e0-7fb2-4c01-8fb8-272130599d4b

# Optional
OPENCLAW_AGENT_ID=openclaw-gateway          # Agent identifier
ENABLE_CFN_READ=true                         # Enable/disable read enhancement (default: true)
CFN_READ_MIN_REPLY_LENGTH=100                # Minimum reply length to enhance (default: 100)
```

### Usage

1. **Configure environment variables** in your shell or `.env` file:
   ```bash
   export CFN_NODE_URL=http://nispatil-m-qlpj.local:9002
   export WORKSPACE_ID=f968acc3-640b-4bb3-95ad-7d2a3a72a399
   export MAS_ID=cfc3c6e0-7fb2-4c01-8fb8-272130599d4b
   export ENABLE_CFN_READ=true  # Optional, default: true
   ```

2. **Restart OpenClaw** to load the plugin

3. **Verify plugin is loaded** by checking logs for:
   ```
   [CFN-ENHANCED] CFN Enhanced Capture Plugin (with Read) Loading...
   [CFN-ENHANCED] CFN Read Enhancement: ENABLED
   ```

## How It Works

### Write Flow

```
User message → llm_input hook → Capture user message
                                ↓
Agent processes → tool calls → Capture tool calls
                                ↓
Agent reply → llm_output hook → Capture response + usage
                                ↓
Agent end → agent_end hook → Send accumulated data to CFN
```

**CFN Write Endpoint:**
```
POST /api/workspaces/{workspaceId}/multi-agentic-systems/{masId}/shared-memories
```

### Read Flow

```
Agent generates reply → before_agent_reply hook
                                ↓
                        Extract intent from reply
                                ↓
                        Query CFN for relevant context
                                ↓
                        Inject context into reply
                                ↓
                        Return enhanced reply to user
```

**CFN Query Endpoint:**
```
POST /api/workspaces/{workspaceId}/multi-agentic-systems/{masId}/shared-memories/query

Request:
{
  "header": { "agent_id": "openclaw-gateway" },
  "search_strategy": "semantic_graph_traversal",
  "intent": "Relevant context for: [extracted from reply]"
}

Response:
{
  "response_id": "...",
  "message": "Relevant context from knowledge graph..."
}
```

## Example Enhanced Reply

**Original Agent Reply:**
```
Let me help you implement user authentication...
```

**Enhanced Reply (with CFN context):**
```
Let me help you implement user authentication...

---

**📚 Relevant Context from Past Conversations:**

The Q2 budget planning session is constrained by a total budget of $200,000. 
Alex mentioned that the authentication service needs to be implemented by the 
end of Q2. Previous discussions indicated JWT tokens should be used with a 
15-minute expiry.
```

## Hooks Used

### Write Hooks
- `llm_input` - Capture user prompts
- `llm_output` - Capture agent responses
- `before_tool_call` / `after_tool_call` - Track tool usage
- `agent_end` - Send accumulated conversation data
- `session_end` - Final cleanup and send
- `message_received` - Capture inter-agent messages
- `subagent_ended` - Capture subagent conversations

### Read Hooks
- `before_agent_reply` - Query CFN and inject context before sending reply to user

## Data Format

The plugin uses the `openclaw-conversation-v1` schema:

```typescript
{
  schema: "openclaw-conversation-v1",
  extractedAt: "2026-04-20T...",
  session: {
    agentId: "openclaw-gateway",
    sessionId: "session-123",
    sessionKey: "main",
    channel: "cli",
    cwd: "/path/to/project"
  },
  stats: {
    totalEntries: 10,
    turns: 5,
    toolCallCount: 8,
    thinkingTurnCount: 2,
    totalCost: 0.0245
  },
  turns: [
    {
      index: 0,
      timestamp: "2026-04-20T...",
      model: "claude-sonnet-4-5",
      stopReason: "end_turn",
      usage: { ... },
      userMessage: "...",
      thinking: "...",
      toolCalls: [ ... ],
      response: "..."
    }
  ]
}
```

## Troubleshooting

### Plugin not loading
- Check `openclaw.plugin.json` points to the correct `.ts` file
- Verify the plugin directory is in OpenClaw's extension path
- Check console logs for errors

### CFN connection issues
- Verify `CFN_NODE_URL` is correct and CFN is running
- Check network connectivity to CFN
- Look for connection errors in plugin logs: `[CFN-ENHANCED]`

### No context enhancement
- Set `ENABLE_CFN_READ=true`
- Ensure replies are longer than `CFN_READ_MIN_REPLY_LENGTH`
- Check CFN has data in the knowledge graph
- Verify the query endpoint is working: `curl -X POST http://..../query`

### Logs

Plugin logs are prefixed with `[CFN-ENHANCED]`:
```
[CFN-ENHANCED] CFN Enhanced Capture Plugin (with Read) Loading...
[CFN-ENHANCED] CFN URL: http://nispatil-m-qlpj.local:9002
[CFN-ENHANCED] CFN Read Enhancement: ENABLED
[CFN-ENHANCED] ✓ CFN reachable (HTTP 200)
[CFN-ENHANCED] 📤 LLM Input: Turn 0 started (156 chars)
[CFN-ENHANCED] 🔍 Enhancing agent reply with CFN context...
[CFN-ENHANCED] ✓ Enhanced reply with 245 chars of CFN context
```

## Performance Considerations

- **Query timeout:** 60 seconds (configurable in code)
- **Write timeout:** 30 seconds (configurable in code)
- **Minimum reply length:** 100 chars (configurable via env)
- Queries run synchronously before agent starts, may add ~1-3s latency
- Failed queries are logged but don't block agent replies

## Development

To modify the plugin:

1. Edit the `.ts` file
2. Restart OpenClaw to reload
3. Check logs for errors
4. Test with various conversation scenarios

## References

- [CFN Shared Memory Operations](http://nispatil-m-qlpj.local:9002/docs/shared-memory-operations.md)
- [OpenClaw Plugin SDK](openclaw/plugin-sdk/plugin-entry)
- [Agent Interaction Logger Example](/home/ubuntu/ssd/agent-interaction-logger)
