#!/bin/bash
# Wrapper script to run CFN MCP Server with its virtual environment

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Activate virtual environment and run server
source venv/bin/activate
exec python3 cfn_mcp_server.py
