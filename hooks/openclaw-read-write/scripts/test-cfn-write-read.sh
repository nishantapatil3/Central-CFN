#!/bin/bash
# Test CFN Shared Memories Write and Read via Mycelium Backend
# Uses the openclaw-conversation-v1 format that the extraction service expects

set -e

# Load config if available
if [ -f ~/.openclaw/cfn-config.sh ]; then
    source ~/.openclaw/cfn-config.sh
fi

# Check if we should use mycelium backend or CFN directly
MYCELIUM_BACKEND_URL="${MYCELIUM_BACKEND_URL:-}"
CFN_NODE_URL="${CFN_NODE_URL:-http://nispatil-m-qlpj.local:9002}"
WORKSPACE_ID="${WORKSPACE_ID:-f968acc3-640b-4bb3-95ad-7d2a3a72a399}"
MAS_ID="${MAS_ID:-cfc3c6e0-7fb2-4c01-8fb8-272130599d4b}"
AGENT_ID="${AGENT_ID:-openclaw-gateway}"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "Testing CFN Shared Memories Write & Read"
echo "========================================="
echo ""
echo "Configuration:"
if [ -n "$MYCELIUM_BACKEND_URL" ]; then
    echo "  Mode: Via Mycelium Backend"
    echo "  Backend URL: ${MYCELIUM_BACKEND_URL}"
else
    echo "  Mode: Direct to CFN"
    echo "  CFN Node URL: ${CFN_NODE_URL}"
fi
echo "  Workspace ID: ${WORKSPACE_ID}"
echo "  MAS ID: ${MAS_ID}"
echo "  Agent ID: ${AGENT_ID}"
echo ""

# Generate unique IDs for this test
TIMESTAMP=$(date +%s)
TIMESTAMP_ISO=$(date -Iseconds)
SESSION_ID="test-session-${TIMESTAMP}"
SESSION_KEY="agent:${AGENT_ID}:test:${TIMESTAMP}"

# ============================================================================
# WRITE: Store shared memory using openclaw-conversation-v1 format
# ============================================================================
echo -e "${BLUE}[1/2] Writing test data to CFN...${NC}"

# Build the openclaw-conversation-v1 payload
OPENCLAW_PAYLOAD=$(cat <<EOF
{
  "schema": "openclaw-conversation-v1",
  "extractedAt": "${TIMESTAMP_ISO}",
  "session": {
    "agentId": "${AGENT_ID}",
    "sessionId": "${SESSION_ID}",
    "sessionKey": "${SESSION_KEY}",
    "channel": "test",
    "cwd": "/home/test"
  },
  "stats": {
    "totalEntries": 2,
    "turns": 1,
    "toolCallCount": 0,
    "thinkingTurnCount": 0,
    "totalCost": 0
  },
  "turns": [
    {
      "index": 0,
      "timestamp": "${TIMESTAMP_ISO}",
      "model": "test-model",
      "stopReason": "stop",
      "usage": {
        "input": 10,
        "output": 20,
        "totalTokens": 30,
        "cost": {
          "input": 0,
          "output": 0,
          "total": 0
        }
      },
      "userMessage": "This is a test message from shell script at ${TIMESTAMP}",
      "thinking": null,
      "toolCalls": [],
      "response": "Test response acknowledging the message at ${TIMESTAMP}"
    }
  ]
}
EOF
)

if [ -n "$MYCELIUM_BACKEND_URL" ]; then
    # Use mycelium backend format
    WRITE_PAYLOAD=$(cat <<EOF
{
  "workspace_id": "${WORKSPACE_ID}",
  "mas_id": "${MAS_ID}",
  "agent_id": "${AGENT_ID}",
  "records": [${OPENCLAW_PAYLOAD}]
}
EOF
)
    WRITE_URL="${MYCELIUM_BACKEND_URL}/api/knowledge/ingest"
else
    # Use CFN direct format
    WRITE_PAYLOAD=$(cat <<EOF
{
  "request_id": "turn-${TIMESTAMP}",
  "header": {
    "agent_id": "${AGENT_ID}"
  },
  "payload": {
    "metadata": {
      "format": "openclaw"
    },
    "data": [${OPENCLAW_PAYLOAD}]
  }
}
EOF
)
    WRITE_URL="${CFN_NODE_URL}/api/workspaces/${WORKSPACE_ID}/multi-agentic-systems/${MAS_ID}/shared-memories"
fi

WRITE_RESULT=$(curl -s -w "\n%{http_code}" -X POST \
    "${WRITE_URL}" \
    -H "Content-Type: application/json" \
    -d "${WRITE_PAYLOAD}")

HTTP_CODE=$(echo "$WRITE_RESULT" | tail -n1)
RESPONSE_BODY=$(echo "$WRITE_RESULT" | sed '$d')

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    echo -e "${GREEN}✓ Write successful (HTTP ${HTTP_CODE})${NC}"
    echo "Response:"
    echo "$RESPONSE_BODY"
    echo ""
else
    echo -e "${RED}✗ Write failed (HTTP ${HTTP_CODE})${NC}"
    echo "Response: $RESPONSE_BODY"
    echo ""
    exit 1
fi

# Wait for processing and indexing
echo "Waiting 5 seconds for processing and indexing..."
sleep 5
echo ""

# ============================================================================
# READ: Query shared memories using natural language intent
# ============================================================================
echo -e "${BLUE}[2/2] Querying shared memories...${NC}"

QUERY_PAYLOAD=$(cat <<EOF
{
  "header": {
    "agent_id": "${AGENT_ID}"
  },
  "request_id": "query-req-${TIMESTAMP}",
  "intent": "Find test messages from ${AGENT_ID} with session ${SESSION_ID}",
  "search_strategy": "semantic_graph_traversal"
}
EOF
)

QUERY_RESULT=$(curl -s -w "\n%{http_code}" -X POST \
    "${CFN_NODE_URL}/api/workspaces/${WORKSPACE_ID}/multi-agentic-systems/${MAS_ID}/shared-memories/query" \
    -H "Content-Type: application/json" \
    -d "${QUERY_PAYLOAD}")

HTTP_CODE=$(echo "$QUERY_RESULT" | tail -n1)
RESPONSE_BODY=$(echo "$QUERY_RESULT" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ Query successful (HTTP ${HTTP_CODE})${NC}"
    echo ""
    echo "Query Result:"
    echo "-------------"
    echo "$RESPONSE_BODY" | head -c 1000
    echo ""
    echo ""
    echo -e "${GREEN}✓ Test data successfully written and retrieved${NC}"
else
    echo -e "${YELLOW}⚠ Query returned HTTP ${HTTP_CODE}${NC}"
    echo "Response: $RESPONSE_BODY"
    echo ""
    echo "Note: Query may fail if:"
    echo "  - Extraction/indexing not complete (try waiting longer)"
    echo "  - LLM not configured in CFN (entity extraction needs LLM)"
    echo "  - Memory not yet searchable"
fi

echo ""
echo "========================================="
echo "Test complete"
echo ""
echo "Test identifiers:"
echo "  Timestamp: ${TIMESTAMP}"
echo "  Session ID: ${SESSION_ID}"
echo "  Session Key: ${SESSION_KEY}"
