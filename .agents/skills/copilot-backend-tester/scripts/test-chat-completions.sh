#!/bin/bash
# Test GitHub Copilot /chat/completions endpoint directly
# Usage: ./test-chat-completions.sh [model] [--stream] [--prompt TEXT] [--business] [--proxy-url URL] [--show-headers]
#
# Examples:
#   ./test-chat-completions.sh gpt-5
#   ./test-chat-completions.sh gpt-5-mini --stream

set -euo pipefail

PROXY_URL="${COPILOT_PROXY_URL:-http://localhost:4141}"
MODEL="${1:-gpt-5}"
shift || true

COPILOT_VERSION="${COPILOT_VERSION:-0.44.1}"
VSCODE_VERSION="${VSCODE_VERSION:-1.116.0}"
COPILOT_API_VERSION="${COPILOT_API_VERSION:-2025-10-01}"
EDITOR_PLUGIN_VERSION="copilot-chat/${COPILOT_VERSION}"
USER_AGENT="GitHubCopilotChat/${COPILOT_VERSION}"

STREAM=false
PROMPT="What is 2+2? Answer in one word."
INITIATOR="agent"
SHOW_HEADERS=false
COPILOT_BASE="https://api.individual.githubcopilot.com"

while [[ $# -gt 0 ]]; do
  case $1 in
    --business) COPILOT_BASE="https://api.business.githubcopilot.com"; shift ;;
    --proxy-url) PROXY_URL="$2"; shift 2 ;;
    --stream) STREAM=true; shift ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --initiator) INITIATOR="$2"; shift 2 ;;
    --show-headers) SHOW_HEADERS=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

COPILOT_TOKEN=$(curl -s "$PROXY_URL/token" | jq -r '.token')
if [ -z "$COPILOT_TOKEN" ] || [ "$COPILOT_TOKEN" = "null" ]; then
  echo "ERROR: Failed to get Copilot token from $PROXY_URL/token"
  exit 1
fi
echo "Token: ${COPILOT_TOKEN:0:30}..."

STREAM_JSON="false"
if [ "$STREAM" = true ]; then STREAM_JSON="true"; fi

BODY=$(cat <<ENDJSON
{
  "model": "$MODEL",
  "max_tokens": 1024,
  "stream": $STREAM_JSON,
  "messages": [{"role": "user", "content": "$PROMPT"}]
}
ENDJSON
)

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
  HEADER_FILE=$(mktemp)
  curl -sN -D "$HEADER_FILE" "$COPILOT_BASE/chat/completions" "${HEADERS[@]}" -d "$BODY"
  if [ "$SHOW_HEADERS" = true ]; then
    echo ""
    echo "=== Response Headers ==="
    cat "$HEADER_FILE"
  fi
  rm -f "$HEADER_FILE"
else
  HEADER_FILE=$(mktemp)
  BODY_FILE=$(mktemp)
  curl -sS -D "$HEADER_FILE" -o "$BODY_FILE" "$COPILOT_BASE/chat/completions" "${HEADERS[@]}" -d "$BODY"
  if [ "$SHOW_HEADERS" = true ]; then
    echo "=== Response Headers ==="
    cat "$HEADER_FILE"
    echo ""
  fi
  cat "$BODY_FILE" | jq .
  rm -f "$HEADER_FILE" "$BODY_FILE"
fi
