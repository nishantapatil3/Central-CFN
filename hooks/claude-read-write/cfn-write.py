#!/usr/bin/env python3
"""
CFN Write Hook — Uses Claude Code's Stop hook to write to central CFN shared memory.

Writes conversation turns to the central CFN shared memory after agent completion.

Hook input (stdin JSON from Claude Code):
{
  "event": "Stop",
  "session_id": "<uuid>",
  "transcript_path": "/path/to/session.jsonl",
  "cwd": "/path/to/workspace"
}

Config (~/cfn-claude-code/config.json):
{
  "cfn_node_url": "http://localhost:9002",
  "workspace_id": "<uuid>",
  "mas_id": "<uuid>",
  "agent_id": "claude-code",
  "enabled": true,
  "write_timeout": 30,
  "max_text_bytes": 8192,
  "max_tool_bytes": 4096
}
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# Paths
HOME = Path.home()
CONFIG_PATH = HOME / "cfn-claude-code" / "config.json"
LOG_FILE = HOME / "cfn-claude-code" / "logs" / "cfn-write.log"


def log(message: str) -> None:
    """Append to log file."""
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        timestamp = __import__("datetime").datetime.now().isoformat()
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(f"{timestamp} [CFN-WRITE] {message}\n")
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


def read_transcript(path: Path) -> list[dict[str, Any]]:
    """Read JSONL transcript file."""
    if not path.exists():
        return []
    entries = []
    try:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return entries


def extract_text_from_content(content: Any) -> str:
    """Extract text from Claude message content."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                chunks.append(block["text"])
        return "".join(chunks)
    return ""


def truncate(value: Any, max_bytes: int) -> Any:
    """Truncate large values to keep payload size reasonable."""
    if max_bytes <= 0 or value is None:
        return value
    if isinstance(value, str):
        encoded = value.encode("utf-8")
        if len(encoded) <= max_bytes:
            return value
        head = encoded[:max_bytes].decode("utf-8", errors="ignore")
        return f"{head}...[truncated]"
    if isinstance(value, (dict, list)):
        serialized = json.dumps(value, default=str)
        if len(serialized.encode("utf-8")) <= max_bytes:
            return value
        head = serialized[:max_bytes]
        return f"{head}...[truncated]"
    return value


def extract_last_turn(entries: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any] | None:
    """Extract the most recent complete conversation turn."""
    max_text = config.get("max_text_bytes", 8192)
    max_tool = config.get("max_tool_bytes", 4096)

    current = None
    pending_tools = {}

    for entry in entries:
        etype = entry.get("type")
        msg = entry.get("message", {})
        role = msg.get("role") if isinstance(msg, dict) else None
        content = msg.get("content") if isinstance(msg, dict) else None

        # New user turn
        if etype == "user" and role == "user":
            if current is not None:
                # Save previous turn (we only return the last one)
                pass
            current = {
                "timestamp": entry.get("timestamp"),
                "user_message": truncate(extract_text_from_content(content), max_text),
                "thinking": [],
                "tool_calls": [],
                "response": "",
                "model": None,
                "stop_reason": None,
                "usage": None
            }
            pending_tools = {}
            continue

        # Assistant response
        if etype == "assistant" and role == "assistant" and current is not None:
            if isinstance(msg.get("model"), str):
                current["model"] = msg["model"]
            if isinstance(msg.get("stop_reason"), str):
                current["stop_reason"] = msg["stop_reason"]
            if isinstance(msg.get("usage"), dict):
                current["usage"] = msg["usage"]

            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type")
                    if btype == "thinking" and isinstance(block.get("thinking"), str):
                        current["thinking"].append(block["thinking"])
                    elif btype == "text" and isinstance(block.get("text"), str):
                        current["response"] += block["text"]
                    elif btype == "tool_use":
                        tc = {
                            "id": block.get("id"),
                            "name": block.get("name", "unknown"),
                            "input": truncate(block.get("input", {}), max_tool),
                            "result": None,
                            "is_error": None
                        }
                        current["tool_calls"].append(tc)
                        if tc["id"]:
                            pending_tools[tc["id"]] = tc

    if current:
        # Combine thinking blocks
        current["thinking"] = truncate("\n\n".join(current["thinking"]), max_text) if current["thinking"] else None
        current["response"] = truncate(current["response"], max_text) if current["response"] else None
        return current

    return None


def write_to_cfn(config: dict[str, Any], turn: dict[str, Any], session_id: str, cwd: str | None) -> bool:
    """Write conversation turn to central CFN shared memory."""
    url = f"{config['cfn_node_url']}/api/workspaces/{config['workspace_id']}/multi-agentic-systems/{config['mas_id']}/shared-memories"

    # Build payload
    trace_parts = [
        f"Session: {session_id}",
        f"CWD: {cwd or 'unknown'}",
        f"Model: {turn.get('model') or 'unknown'}",
        f"Timestamp: {turn.get('timestamp') or 'unknown'}",
        "",
        f"User: {turn.get('user_message', '')}"
    ]

    if turn.get("thinking"):
        trace_parts.append(f"\nThinking: {turn['thinking']}")

    for tc in turn.get("tool_calls", []):
        trace_parts.append(f"\nTool: {tc['name']}")
        trace_parts.append(f"Input: {json.dumps(tc['input'])}")
        if tc.get("result"):
            trace_parts.append(f"Result: {tc['result']}")

    if turn.get("response"):
        trace_parts.append(f"\nAssistant: {turn['response']}")

    trace = "\n".join(trace_parts)

    payload = {
        "header": {
            "agent_id": config.get("agent_id", "claude-code")
        },
        "payload": {
            "type": "trace",
            "trace": trace
        }
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

    timeout = config.get("write_timeout", 30)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if 200 <= resp.status < 300:
                log(f"✓ Wrote turn to CFN ({len(trace)} chars)")
                return True
            else:
                log(f"CFN write failed: HTTP {resp.status}")
                return False
    except Exception as e:
        log(f"CFN write error: {e}")
        return False


def main() -> int:
    """Main hook entry point."""
    try:
        # Read hook input from stdin
        hook_input_raw = sys.stdin.read()
        if not hook_input_raw.strip():
            return 0

        hook_input = json.loads(hook_input_raw)
        session_id = hook_input.get("session_id", "unknown")
        transcript_path = hook_input.get("transcript_path")
        cwd = hook_input.get("cwd")

        # Load config
        config = load_config()

        # Check if enabled
        if not config.get("enabled", False):
            log("CFN write disabled in config")
            return 0

        # Validate required config
        required = ["cfn_node_url", "workspace_id", "mas_id"]
        for key in required:
            if not config.get(key):
                log(f"Missing required config: {key}")
                return 0

        if not transcript_path:
            log("No transcript path provided")
            return 0

        # Read transcript
        entries = read_transcript(Path(transcript_path))
        if not entries:
            log("No transcript entries found")
            return 0

        # Extract last turn
        turn = extract_last_turn(entries, config)
        if not turn:
            log("No complete turn found")
            return 0

        log(f"Writing turn to CFN (session: {session_id})")

        # Write to CFN
        write_to_cfn(config, turn, session_id, cwd)

        return 0

    except Exception as e:
        log(f"Hook failed: {e}")
        return 0  # Never fail - swallow all errors


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
