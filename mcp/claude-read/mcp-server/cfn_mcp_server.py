#!/usr/bin/env python3
"""
CFN MCP Server - Exposes CFN shared-memories as MCP tools for Claude Code

This MCP server wraps the existing CFN API without requiring any changes to CFN.
Claude can proactively query CFN memory when it needs context.
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# MCP SDK
try:
    from mcp.server import Server
    from mcp.server.stdio import stdio_server
    from mcp.types import Tool, TextContent
except ImportError:
    print("Error: MCP SDK not installed. Run: pip install mcp", file=sys.stderr)
    sys.exit(1)

# Config path
HOME = Path.home()
CONFIG_PATH = HOME / "cfn-claude-code" / "config.json"
LOG_FILE = HOME / "cfn-claude-code" / "logs" / "cfn-mcp.log"


def log(message: str) -> None:
    """Append to log file."""
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        timestamp = __import__("datetime").datetime.now().isoformat()
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(f"{timestamp} [CFN-MCP] {message}\n")
    except Exception:
        pass


def load_config() -> dict[str, Any]:
    """Load configuration from config.json."""
    if not CONFIG_PATH.exists():
        log(f"Config not found at {CONFIG_PATH}")
        return {}
    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as f:
            config = json.load(f)
            log(f"Config loaded: workspace_id={config.get('workspace_id')}, mas_id={config.get('mas_id')}")
            return config
    except Exception as e:
        log(f"Failed to load config: {e}")
        return {}


def query_cfn(config: dict[str, Any], intent: str) -> dict[str, Any]:
    """
    Query CFN shared-memories for relevant context.

    Returns:
        {"success": True, "message": "context"} or {"success": False, "error": "reason"}
    """
    # Validate config
    required = ["cfn_node_url", "workspace_id", "mas_id"]
    for key in required:
        if not config.get(key):
            error = f"Missing required config: {key}"
            log(error)
            return {"success": False, "error": error}

    url = f"{config['cfn_node_url']}/api/workspaces/{config['workspace_id']}/multi-agentic-systems/{config['mas_id']}/shared-memories/query"

    payload = {
        "header": {
            "agent_id": config.get("agent_id", "claude-code")
        },
        "search_strategy": "semantic_graph_traversal",
        "intent": intent
    }

    log(f"Querying CFN: {intent[:100]}...")

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        method="POST"
    )

    timeout = config.get("query_timeout", 60)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                response_data = b""
                while True:
                    chunk = resp.read(8192)
                    if not chunk:
                        break
                    response_data += chunk

                if not response_data:
                    log("Empty response from CFN")
                    return {"success": False, "error": "Empty response from CFN"}

                decoded_response = response_data.decode("utf-8")
                result = json.loads(decoded_response)
                message = result.get("message")

                if message and len(str(message).strip()) > 0:
                    log(f"✓ CFN returned {len(str(message))} chars")
                    log(f"📕 Context: {str(result)}")
                    return {"success": True, "message": str(message)}
                else:
                    log("No relevant context found")
                    return {"success": False, "error": "No relevant context found in CFN"}
            else:
                error = f"CFN query failed: HTTP {resp.status}"
                log(error)
                return {"success": False, "error": error}

    except urllib.error.HTTPError as e:
        error = f"HTTP error: {e.code} {e.reason}"
        log(error)
        return {"success": False, "error": error}
    except (urllib.error.URLError, TimeoutError) as e:
        error = f"Network error: {e}"
        log(error)
        return {"success": False, "error": error}
    except Exception as e:
        error = f"Unexpected error: {e}"
        log(error)
        return {"success": False, "error": error}


# Create MCP server
app = Server("cfn-memory")


@app.list_tools()
async def list_tools() -> list[Tool]:
    """List available tools."""
    return [
        Tool(
            name="query_cfn_memory",
            description=(
                "Query the Central CFN (Collaborative Function Network) shared memory system. "
                "Use this to retrieve context about past incidents, project information, "
                "decisions, conversations, or any information that may have been stored by other agents. "
                "Particularly useful for questions about recent events, project history, or incident details."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query or question to ask CFN's memory system"
                    }
                },
                "required": ["query"]
            }
        )
    ]


@app.call_tool()
async def call_tool(name: str, arguments: Any) -> list[TextContent]:
    """Handle tool calls."""
    if name != "query_cfn_memory":
        return [TextContent(type="text", text=f"Unknown tool: {name}")]

    query = arguments.get("query", "")
    if not query:
        return [TextContent(type="text", text="Error: query parameter is required")]

    # Load config
    config = load_config()

    # Query CFN
    result = query_cfn(config, query)

    if result["success"]:
        return [TextContent(
            type="text",
            text=result["message"]
        )]
    else:
        return [TextContent(
            type="text",
            text=f"Failed to query CFN: {result['error']}"
        )]


async def main():
    """Run the MCP server."""
    log("CFN MCP Server starting...")
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
