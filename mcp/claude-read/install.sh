#!/bin/bash
# CFN Claude Code Plugin Installer

set -e

echo "Installing CFN Claude Code Plugin..."

# Create Claude plugins directory
mkdir -p ~/.claude/plugins

# Copy plugin
cp -r ~/cfn-claude-code ~/.claude/plugins/

# Make hooks executable
chmod +x ~/.claude/plugins/cfn-claude-code/hooks/*.py

# Copy sample config if not exists
if [ ! -f ~/.claude/plugins/cfn-claude-code/config.json ]; then
    cp ~/.claude/plugins/cfn-claude-code/config.json.sample ~/.claude/plugins/cfn-claude-code/config.json
    echo "✓ Created config.json (edit with your CFN details)"
else
    echo "✓ config.json already exists"
fi

echo ""
echo "✓ Plugin installed to ~/.claude/plugins/cfn-claude-code/"
echo ""
echo "Next steps:"
echo "1. Edit ~/.claude/plugins/cfn-claude-code/config.json with your CFN details"
echo "2. Add hooks to ~/.claude/settings.json (see README.md)"
echo "3. Restart Claude Code"
