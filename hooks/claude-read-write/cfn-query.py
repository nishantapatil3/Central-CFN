#!/usr/bin/env python3
"""
CFN Query Hook (Claude Code - UserPromptSubmit)

Queries CFN's shared-memories before the agent runs and injects relevant
context into the system prompt.

Hook input (stdin JSON from Claude Code):
{
  "event": "UserPromptSubmit",
  "user_prompt": "<user message>",
  "session_id": "<uuid>",
  "cwd": "/path/to/workspace"
}

Hook output (stdout JSON):
{
  "prependContext": "<context to inject>"
}

Config (~/cfn-claude-code/config.json):
{
  "cfn_node_url": "http://localhost:9002",
  "workspace_id": "<uuid>",
  "mas_id": "<uuid>",
  "agent_id": "claude-code",
  "enabled": true,
  "query_timeout": 60,
  "min_query_length": 10
}
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# Paths
HOME = Path.home()
CONFIG_PATH = HOME / "cfn-claude-code" / "config.json"
LOG_FILE = HOME / "cfn-claude-code" / "logs" / "cfn-query.log"


def log(message: str) -> None:
    """Append to log file."""
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        timestamp = __import__("datetime").datetime.now().isoformat()
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(f"{timestamp} [CFN-QUERY] {message}\n")
    except Exception:
        pass


def load_config() -> dict[str, Any]:
    """Load configuration from config.json."""
    if not CONFIG_PATH.exists():
        return {}
    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log(f"Failed to load config: {e}")
        return {}


def query_cfn(config: dict[str, Any], intent: str) -> str | None:
    """Query CFN shared-memories for relevant context."""
    url = f"{config['cfn_node_url']}/api/workspaces/{config['workspace_id']}/multi-agentic-systems/{config['mas_id']}/shared-memories/query"

    payload = {
        "header": {
            "agent_id": config.get("agent_id", "claude-code")
        },
        "search_strategy": "semantic_graph_traversal",
        "intent": intent
    }

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
                result = json.loads(resp.read().decode("utf-8"))
                message = result.get("message")
                if message and len(message) > 10:
                    log(f"✓ CFN returned {len(message)} chars of context")
                    log(f"Context: {message[:200]}...")
                    return message
                else:
                    log("No relevant context found")
                    return None
            else:
                log(f"CFN query failed: HTTP {resp.status}")
                return None
    except urllib.error.HTTPError as e:
        log(f"CFN query HTTP error: {e.code} {e.reason}")
        return None
    except (urllib.error.URLError, TimeoutError) as e:
        log(f"CFN query error: {e}")
        return None
    except Exception as e:
        log(f"Unexpected error: {e}")
        return None


def main() -> int:
    """Main hook entry point."""
    try:
        # Read hook input from stdin
        hook_input_raw = sys.stdin.read()
        if not hook_input_raw.strip():
            return 0

        hook_input = json.loads(hook_input_raw)
        user_prompt = hook_input.get("user_prompt", "").strip()

        # Load config
        config = load_config()

        # Check if enabled
        if not config.get("enabled", False):
            log("CFN query disabled in config")
            return 0

        # Validate required config
        required = ["cfn_node_url", "workspace_id", "mas_id"]
        for key in required:
            if not config.get(key):
                log(f"Missing required config: {key}")
                return 0

        # Check minimum query length
        min_length = config.get("min_query_length", 10)
        if len(user_prompt) < min_length:
            log(f"Query too short: {len(user_prompt)} chars (min: {min_length})")
            return 0

        log(f"Querying CFN with intent: {user_prompt[:100]}...")

        # Query CFN
        context = query_cfn(config, user_prompt)

        if context:
            # Inject context into system prompt
            injection = f"\n\n## Relevant Context from Central CFN\n\nThe following information was retrieved from the shared memory system and may be relevant to the user's query:\n\n{context}\n"

            # Output hook result
            result = {
                "prependContext": injection
            }
            print(json.dumps(result), flush=True)
            log("✓ Context injected into prompt")
        else:
            log("No context to inject")

        return 0

    except Exception as e:
        log(f"Hook failed: {e}")
        return 0  # Never fail - swallow all errors


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
