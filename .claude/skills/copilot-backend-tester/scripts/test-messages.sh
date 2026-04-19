#!/bin/bash
# Test GitHub Copilot /v1/messages endpoint directly
# Usage: ./test-messages.sh [model] [--adaptive] [--effort LEVEL] [--stream] [--thinking N]
#
# Examples:
#   ./test-messages.sh claude-opus-4.6 --adaptive --effort max
#   ./test-messages.sh claude-sonnet-4 --stream
#   ./test-messages.sh claude-opus-4.5 --thinking 4096

set -euo pipefail

PROXY_URL="${COPILOT_PROXY_URL:-http://localhost:4141}"
MODEL="${1:-claude-opus-4.6}"
shift || true

COPILOT_VERSION="${COPILOT_VERSION:-0.44.1}"
VSCODE_VERSION="${VSCODE_VERSION:-1.116.0}"
COPILOT_API_VERSION="${COPILOT_API_VERSION:-2025-10-01}"
EDITOR_PLUGIN_VERSION="copilot-chat/${COPILOT_VERSION}"
USER_AGENT="GitHubCopilotChat/${COPILOT_VERSION}"

ADAPTIVE=false
EFFORT=""
STREAM=false
THINKING_BUDGET=""
PROMPT="What is 2+2? Answer in one word."
INITIATOR="agent"

while [[ $# -gt 0 ]]; do
  case $1 in
    --adaptive) ADAPTIVE=true; shift ;;
    --effort) EFFORT="$2"; shift 2 ;;
    --stream) STREAM=true; shift ;;
    --thinking) THINKING_BUDGET="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --initiator) INITIATOR="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

COPILOT_TOKEN=$(curl -s "$PROXY_URL/token" | jq -r '.token')
if [ -z "$COPILOT_TOKEN" ] || [ "$COPILOT_TOKEN" = "null" ]; then
  echo "ERROR: Failed to get Copilot token from $PROXY_URL/token"
  exit 1
fi
echo "Token: ${COPILOT_TOKEN:0:30}..."

THINKING_JSON=""
if [ "$ADAPTIVE" = true ]; then
  THINKING_JSON='"thinking": {"type": "adaptive"},'
elif [ -n "$THINKING_BUDGET" ]; then
  THINKING_JSON='"thinking": {"type": "enabled", "budget_tokens": '"$THINKING_BUDGET"'},'
fi

OUTPUT_CONFIG=""
if [ -n "$EFFORT" ]; then
  OUTPUT_CONFIG='"output_config": {"effort": "'"$EFFORT"'"},'
fi

STREAM_JSON="false"
if [ "$STREAM" = true ]; then STREAM_JSON="true"; fi

BODY=$(cat <<ENDJSON
{
  "model": "$MODEL",
  "max_tokens": 1024,
  "stream": $STREAM_JSON,
  $THINKING_JSON
  $OUTPUT_CONFIG
  "temperature": 1,
  "messages": [{"role": "user", "content": "$PROMPT"}]
}
ENDJSON
)

COPILOT_BASE="https://api.individual.githubcopilot.com"

echo ""
echo "=== Request ==="
echo "$BODY" | jq .
echo ""
echo "=== Response ==="

HEADERS=(
  -H "Authorization: Bearer $COPILOT_TOKEN"
  -H "content-type: application/json"
  -H "copilot-integration-id: vscode-chat"
  -H "editor-version: vscode/${VSCODE_VERSION}"
  -H "editor-plugin-version: ${EDITOR_PLUGIN_VERSION}"
  -H "user-agent: ${USER_AGENT}"
  -H "openai-intent: conversation-agent"
  -H "x-github-api-version: ${COPILOT_API_VERSION}"
  -H "X-Initiator: $INITIATOR"
  -H "x-request-id: test-$(cat /proc/sys/kernel/random/uuid)"
)

if [ "$STREAM" = true ]; then
  curl -sN "$COPILOT_BASE/v1/messages" "${HEADERS[@]}" -d "$BODY"
else
  curl -s "$COPILOT_BASE/v1/messages" "${HEADERS[@]}" -d "$BODY" | jq .
fi
