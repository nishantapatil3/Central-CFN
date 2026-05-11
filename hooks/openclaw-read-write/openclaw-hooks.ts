import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

/**
 * CFN Enhanced Capture Plugin with Read Enhancement
 *
 * WRITES: Captures comprehensive OpenClaw data and sends to CFN for knowledge extraction.
 * READS: Queries CFN before agent replies to inject relevant context from past conversations.
 *
 * Uses openclaw-conversation-v1 format with multiple hooks:
 * - llm_input/output: Full prompts and responses
 * - tool calls: Complete tool usage with inputs/outputs
 * - subagents: Multi-agent collaboration
 * - messages: Inter-agent communication
 * - before_agent_reply: Query CFN and enhance response with relevant context
 */

// Load configuration from JSON file if environment variables not set
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let config: any = {};
try {
  const configPath = join(__dirname, "cfn-config.json");
  const configFile = readFileSync(configPath, "utf-8");
  config = JSON.parse(configFile);
} catch (err) {
  // Config file not found or invalid, will use defaults
  log(`⚠️  CFN config file not found or invalid, using defaults and environment variables`);
}

// Configuration: Environment variables take precedence, then JSON config, then defaults
const CFN_NODE_URL = process.env.CFN_NODE_URL || config.CFN_NODE_URL || "http://nispatil-m-qlpj.local:9002";
const WORKSPACE_ID = "89cd3fd1-2f0a-4934-bffb-6d2330dc2154"
const MAS_ID = "05f1a04d-2d80-49d9-a40d-61d384892627"
const AGENT_ID = process.env.OPENCLAW_AGENT_ID || process.env.AGENT_ID || config.AGENT_ID || "openclaw-gateway";

// Feature flags
const ENABLE_CFN_READ = process.env.ENABLE_CFN_READ !== "false"; // enabled by default
const CFN_READ_MIN_REPLY_LENGTH = parseInt(process.env.CFN_READ_MIN_REPLY_LENGTH || "20"); // only enhance replies longer than this

function log(message: string) {
  console.log(`[CFN-ENHANCED] ${message}`);
}

// Session data accumulator
interface TurnData {
  index: number;
  timestamp: string;
  model: string | null;
  stopReason: string | null;
  usage: any;
  userMessage: string;
  thinking: string | null;
  toolCalls: Array<{
    id: string | null;
    name: string;
    input: any;
    result: any;
    isError: boolean;
  }>;
  response: string;
}

const activeSessions = new Map<string, {
  turns: TurnData[];
  sessionId: string;
  sessionKey: string;
  agentId: string;
  channel: string;
  cwd: string | null;
  startedAt: string;
  lastActivity: string;
}>();

const pendingToolCalls = new Map<string, {
  sessionKey: string;
  name: string;
  input: any;
  timestamp: string;
}>();

// ============================================================================
// WRITE TO CFN - Send captured conversations
// ============================================================================

async function sendToCFN(sessionData: any) {
  const url = `${CFN_NODE_URL}/api/workspaces/${WORKSPACE_ID}/multi-agentic-systems/${MAS_ID}/shared-memories`;

  try {
    const openclawPayload = {
      schema: "openclaw-conversation-v1",
      extractedAt: new Date().toISOString(),
      session: {
        agentId: sessionData.agentId,
        sessionId: sessionData.sessionId,
        sessionKey: sessionData.sessionKey,
        channel: sessionData.channel,
        cwd: sessionData.cwd,
      },
      stats: {
        totalEntries: sessionData.turns.length * 2, // user + assistant per turn
        turns: sessionData.turns.length,
        toolCallCount: sessionData.turns.reduce((n: number, t: TurnData) => n + t.toolCalls.length, 0),
        thinkingTurnCount: sessionData.turns.filter((t: TurnData) => t.thinking && t.thinking.length > 0).length,
        totalCost: sessionData.turns.reduce((sum: number, t: TurnData) => sum + (t.usage?.cost?.total || 0), 0),
      },
      turns: sessionData.turns,
    };

    const payload = {
      request_id: `turn-${Date.now()}`,
      header: {
        agent_id: sessionData.agentId,
      },
      payload: {
        metadata: {
          format: "openclaw",
          captured_at: new Date().toISOString(),
        },
        data: [openclawPayload],
      },
    };

    log(`  Sending to: ${url}`);
    log(`  Payload size: ${JSON.stringify(payload).length} bytes`);

    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = await response.text();
      log(`✗ CFN write failed (HTTP ${response.status}): ${error.substring(0, 200)}`);
      return false;
    }

    const result = await response.json();
    log(`✓ Sent to CFN: ${sessionData.turns.length} turns`);
    log(`  Response ID: ${result.response_id || "N/A"}`);
    log(`  Status: ${result.status || "N/A"}`);
    log(`  Message: ${result.message || "N/A"}`);
    return true;
  } catch (error) {
    if (error instanceof Error) {
      log(`✗ CFN write error: ${error.name}: ${error.message}`);
      if (error.stack) {
        log(`  Stack: ${error.stack.split('\n')[0]}`);
      }
      // Check for specific error types
      if (error.name === 'AbortError') {
        log(`  (Request timed out after 30 seconds)`);
      } else if (error.message.includes('ECONNREFUSED')) {
        log(`  (Connection refused - is CFN running at ${url}?)`);
      } else if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
        log(`  (DNS lookup failed - cannot resolve ${CFN_NODE_URL})`);
      } else if (error.message.includes('ETIMEDOUT')) {
        log(`  (Connection timed out - network issue?)`);
      }
    } else {
      log(`✗ CFN write error: ${String(error)}`);
    }
    return false;
  }
}

// ============================================================================
// READ FROM CFN - Query for relevant context
// ============================================================================

async function queryContextFromCFN(intent: string): Promise<string | null> {
  const url = `${CFN_NODE_URL}/api/workspaces/${WORKSPACE_ID}/multi-agentic-systems/${MAS_ID}/shared-memories/query`;

  try {
    const queryPayload = {
      header: {
        agent_id: AGENT_ID,
      },
      search_strategy: "semantic_graph_traversal",
      intent: intent,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout for queries

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(queryPayload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = await response.text();
      log(`✗ CFN query failed (H TTP ${response.status}): ${error.substring(0, 200)}`);
      return null;
    }

    const result = await response.json();

    if (result.message) {
      log(`✓ CFN raw response:\n${result.message}`);
      return result.message;
    }

    return null;
  } catch (error) {
    if (error instanceof Error) {
      log(`✗ CFN query error: ${error.name}: ${error.message}`);
    } else {
      log(`✗ CFN query error: ${String(error)}`);
    }
    return null;
  }
}

/**
 * Extract clean user message from prompt (strip all OpenClaw metadata blocks)
 *
 * Metadata blocks follow the pattern:
 * Label (untrusted ...):
 * ```json
 * {...}
 * ```
 */
function extractIntentFromReply(messageText: string): string {
  let cleaned = messageText.trim();

  // Remove ALL untrusted metadata blocks with JSON markdown
  // Pattern: "Any label (untrusted...):\n```json\n{...}\n```\n"
  // Repeat until no more matches (handles multiple blocks)
  while (cleaned.match(/^[^\n]+\(untrusted[^\n]*\):\s*```json[\s\S]*?```\s*/i)) {
    cleaned = cleaned.replace(/^[^\n]+\(untrusted[^\n]*\):\s*```json[\s\S]*?```\s*/i, '');
  }

  // Return the full cleaned message (actual user input with any timestamps they included)
  return cleaned.trim();
}

// ============================================================================
// Session Management
// ============================================================================

function getOrCreateSession(sessionKey: string, ctx: any) {
  if (!activeSessions.has(sessionKey)) {
    activeSessions.set(sessionKey, {
      turns: [],
      sessionId: ctx.sessionId || `session-${Date.now()}`,
      sessionKey: sessionKey,
      agentId: ctx.agentId || AGENT_ID,
      channel: ctx.channelId || "unknown",
      cwd: ctx.workspaceDir || null,
      startedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    });
  }
  return activeSessions.get(sessionKey)!;
}

function getCurrentTurn(session: any): TurnData | null {
  if (session.turns.length === 0) return null;
  return session.turns[session.turns.length - 1];
}

async function testConnection() {
  try {
    log("Testing CFN connection...");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${CFN_NODE_URL}/`, {
      method: "GET",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    log(`✓ CFN reachable (HTTP ${response.status})`);
    return true;
  } catch (error) {
    if (error instanceof Error) {
      log(`✗ CFN connection test failed: ${error.name}: ${error.message}`);
      if (error.message.includes('ECONNREFUSED')) {
        log(`  → Is CFN running at ${CFN_NODE_URL}?`);
      } else if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
        log(`  → Cannot resolve hostname. Check CFN_NODE_URL=${CFN_NODE_URL}`);
      } else if (error.name === 'AbortError') {
        log(`  → Connection timed out. Network issue?`);
      }
    }
    return false;
  }
}

// ============================================================================
// PLUGIN REGISTRATION
// ============================================================================

export function register(api: OpenClawPluginApi) {
  log("CFN Enhanced Capture Plugin (with Read) Loading...");
  log(`CFN URL: ${CFN_NODE_URL}`);
  log(`🪵 Workspace: ${WORKSPACE_ID}`);
  log(`🪵 MAS: ${MAS_ID}`);
  log(`CFN Read Enhancement: ${ENABLE_CFN_READ ? "ENABLED" : "DISABLED"}`);

  // Test connection on startup (don't block registration)
  testConnection().catch(err => log(`Connection test error: ${err}`));

  // ============================================================================
  // BEFORE AGENT START - Inject CFN context into system prompt
  // ============================================================================
  api.on("before_agent_start", async (event, ctx) => {
    if (!ENABLE_CFN_READ) {
      return { handled: false };
    }

    const userMessage = event.prompt || "";

    // Skip enhancement for very short queries
    if (userMessage.length < CFN_READ_MIN_REPLY_LENGTH) {
      log(`⏭️  Skipping CFN enhancement (query too short: ${userMessage.length} chars)`);
      return { handled: false };
    }

    try {
      // Extract intent from the user's message
      const intent = extractIntentFromReply(userMessage);
      log(`🔍 Cleaned intent:\n${intent}`);

      // Query CFN for relevant context
      const cfnContext = await queryContextFromCFN(intent);

      if (cfnContext && cfnContext.length > 10) {
        log(`✓ CFN query response:\n${cfnContext}`);
        log(`✓ Injecting CFN context into system prompt`);

        // Inject CFN context into the system prompt
        const contextInjection = `\n\n## Relevant Context from Central CFN\n\nThe following information was retrieved from the shared memory system and may be relevant to the user's query:\n\n${cfnContext}\n`;

        return {
          handled: true,
          prependContext: contextInjection,
        };
      } else {
        log(`ℹ️  No relevant context found in CFN`);
        return { handled: false };
      }
    } catch (error) {
      log(`✗ Error querying CFN: ${error}`);
      return { handled: false };
    }
  });

  // ============================================================================
  // LLM INPUT - Start a new turn with user message
  // ============================================================================
  api.on("llm_input", async (event, ctx) => {
    const sessionKey = ctx.sessionKey || "main";
    const session = getOrCreateSession(sessionKey, ctx);
    session.lastActivity = new Date().toISOString();

    // Create new turn
    const turn: TurnData = {
      index: session.turns.length,
      timestamp: new Date().toISOString(),
      model: event.model || null,
      stopReason: null,
      usage: null,
      userMessage: event.prompt || "",
      thinking: null,
      toolCalls: [],
      response: "",
    };

    session.turns.push(turn);
    log(`📤 LLM Input: Turn ${turn.index} started (${event.prompt?.length || 0} chars)`);
  });

  // ============================================================================
  // LLM OUTPUT - Complete the turn with response and usage
  // ============================================================================
  api.on("llm_output", async (event, ctx) => {
    const sessionKey = ctx.sessionKey || "main";
    const session = getOrCreateSession(sessionKey, ctx);
    const turn = getCurrentTurn(session);

    if (turn) {
      // Add response text
      if (event.assistantTexts && event.assistantTexts.length > 0) {
        turn.response = event.assistantTexts.join("\n\n");
      }

      // Add usage stats
      if (event.usage) {
        turn.usage = {
          input: event.usage.input || 0,
          output: event.usage.output || 0,
          cacheRead: event.usage.cacheRead || 0,
          cacheWrite: event.usage.cacheWrite || 0,
          totalTokens: event.usage.total || 0,
          cost: {
            input: event.usage.cost?.input || 0,
            output: event.usage.cost?.output || 0,
            cacheRead: event.usage.cost?.cacheRead || 0,
            cacheWrite: event.usage.cost?.cacheWrite || 0,
            total: event.usage.cost?.total || 0,
          },
        };
      }

      turn.model = event.model || turn.model;
      session.lastActivity = new Date().toISOString();

      log(`📥 LLM Output: Turn ${turn.index} completed (${turn.response.length} chars, ${turn.toolCalls.length} tools)`);
    }
  });

  // ============================================================================
  // TOOL CALLS - Track tool usage
  // ============================================================================
  api.on("before_tool_call", async (event, ctx) => {
    const sessionKey = ctx.sessionKey || "main";
    const toolId = `${sessionKey}-${event.name}-${Date.now()}`;

    pendingToolCalls.set(toolId, {
      sessionKey: sessionKey,
      name: event.name || "unknown",
      input: event.input,
      timestamp: new Date().toISOString(),
    });

    log(`🔧 Tool call started: ${event.name}`);
  });

  api.on("after_tool_call", async (event, ctx) => {
    const sessionKey = ctx.sessionKey || "main";

    // Find matching pending call
    const matchingKey = Array.from(pendingToolCalls.keys()).find(
      key => key.startsWith(`${sessionKey}-${event.name}`)
    );

    if (matchingKey) {
      const toolCall = pendingToolCalls.get(matchingKey)!;
      const session = activeSessions.get(sessionKey);
      const turn = session ? getCurrentTurn(session) : null;

      if (turn) {
        turn.toolCalls.push({
          id: null,
          name: toolCall.name,
          input: toolCall.input,
          result: event.content,
          isError: event.isError || false,
        });
      }

      pendingToolCalls.delete(matchingKey);
      log(`✓ Tool call completed: ${event.name} (${event.isError ? "error" : "success"})`);
    }
  });

  // ============================================================================
  // AGENT END - Send accumulated data to CFN
  // ============================================================================
  api.on("agent_end", async (event, ctx) => {
    const sessionKey = ctx.sessionKey || "main";
    const session = activeSessions.get(sessionKey);

    if (session && session.turns.length > 0) {
      log(`🏁 Agent ended: ${session.turns.length} turns captured`);
      await sendToCFN(session);
      // Don't delete - keep for potential future turns
    }
  });

  // ============================================================================
  // SESSION END - Final cleanup and send
  // ============================================================================
  api.on("session_end", async (event, ctx) => {
    const sessionKey = event.sessionKey || "main";
    const session = activeSessions.get(sessionKey);

    if (session && session.turns.length > 0) {
      log(`🎬 Session ending: ${session.turns.length} turns`);
      await sendToCFN(session);
    }

    // Clean up
    activeSessions.delete(sessionKey);
    log(`Session cleanup: ${sessionKey}`);
  });

  // ============================================================================
  // MESSAGE RECEIVED - Capture inter-agent messages as separate events
  // ============================================================================
  api.on("message_received", async (event, ctx) => {
    log(`📨 Message received from: ${event.from}`);

    try {
      const now = new Date().toISOString();
      const sessionId = ctx.sessionId || `msg-session-${Date.now()}`;
      const sessionKey = ctx.sessionKey || "main";
      const agentId = ctx.agentId || AGENT_ID;

      // Build simple single-turn conversation for the message
      const openclawPayload = {
        schema: "openclaw-conversation-v1",
        extractedAt: now,
        session: {
          agentId: agentId,
          sessionId: sessionId,
          sessionKey: sessionKey,
          channel: "inter-agent",
          cwd: null,
        },
        stats: {
          totalEntries: 2,
          turns: 1,
          toolCallCount: 0,
          thinkingTurnCount: 0,
          totalCost: 0,
        },
        turns: [
          {
            index: 0,
            timestamp: event.timestamp || now,
            model: null,
            stopReason: null,
            usage: null,
            userMessage: event.content,
            thinking: null,
            toolCalls: [],
            response: `[Received from ${event.from}]`,
          },
        ],
      };

      const payload = {
        request_id: `msg-received-${Date.now()}`,
        header: {
          agent_id: agentId,
        },
        payload: {
          metadata: {
            format: "openclaw",
            sender: event.from,
            recipient: agentId,
            message_type: "inter-agent",
          },
          data: [openclawPayload],
        },
      };

      const url = `${CFN_NODE_URL}/api/workspaces/${WORKSPACE_ID}/multi-agentic-systems/${MAS_ID}/shared-memories`;

      // Add timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.text();
        log(`✗ Message write failed (HTTP ${response.status}): ${error.substring(0, 100)}`);
        return;
      }

      const result = await response.json();
      log(`✓ Message sent to CFN`);
      log(`  From: ${event.from} → To: ${agentId}`);
    } catch (error) {
      if (error instanceof Error) {
        log(`✗ Message write error: ${error.name}: ${error.message}`);
      } else {
        log(`✗ Message write error: ${String(error)}`);
      }
    }
  });

  // ============================================================================
  // SUBAGENT ENDED - Capture complete subagent conversations
  // ============================================================================
  api.on("subagent_ended", async (event, ctx) => {
    log(`🏁 Subagent ended: ${event.targetSessionKey}`);

    try {
      // Get complete conversation history
      const { messages } = await api.runtime.subagent.getSessionMessages({
        sessionKey: event.targetSessionKey,
        limit: 500,
      });

      if (!messages || messages.length === 0) return;

      log(`  Retrieved ${messages.length} messages from subagent`);

      // Build turns from messages (simplified - just capture the conversation)
      const turns = messages
        .filter((msg: any) => msg.role === "user" || msg.role === "assistant")
        .map((msg: any, idx: number) => ({
          index: idx,
          timestamp: new Date().toISOString(),
          model: null,
          stopReason: null,
          usage: null,
          userMessage: msg.role === "user" ? (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)) : "",
          thinking: null,
          toolCalls: [],
          response: msg.role === "assistant" ? (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)) : "",
        }));

      const openclawPayload = {
        schema: "openclaw-conversation-v1",
        extractedAt: new Date().toISOString(),
        session: {
          agentId: ctx.agentId || AGENT_ID,
          sessionId: event.targetSessionKey,
          sessionKey: event.targetSessionKey,
          channel: "subagent",
          cwd: null,
        },
        stats: {
          totalEntries: messages.length,
          turns: turns.length,
          toolCallCount: 0,
          thinkingTurnCount: 0,
          totalCost: 0,
        },
        turns: turns,
      };

      const payload = {
        request_id: `subagent-${Date.now()}`,
        header: {
          agent_id: ctx.agentId || AGENT_ID,
        },
        payload: {
          metadata: {
            format: "openclaw",
            subagent_session: event.targetSessionKey,
            outcome: event.outcome,
          },
          data: [openclawPayload],
        },
      };

      const url = `${CFN_NODE_URL}/api/workspaces/${WORKSPACE_ID}/multi-agentic-systems/${MAS_ID}/shared-memories`;

      // Add timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.text();
        log(`✗ Subagent write failed (HTTP ${response.status}): ${error.substring(0, 100)}`);
        return;
      }

      const result = await response.json();
      log(`✓ Subagent conversation sent to CFN (${turns.length} turns)`);
    } catch (error) {
      if (error instanceof Error) {
        log(`✗ Subagent write error: ${error.name}: ${error.message}`);
      } else {
        log(`✗ Subagent write error: ${String(error)}`);
      }
    }
  });

  log("✅ CFN Enhanced Capture Plugin Ready with WRITE + READ capabilities");
  log("   - Writes: All conversation data to CFN");
  log("   - Reads: Queries CFN before agent replies to inject relevant context");
}
