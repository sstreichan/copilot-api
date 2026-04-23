#!/bin/bash
# Probe Copilot auto-model routing via /models/session and /models/session/intent,
# then optionally send the final request using the resolved model.
#
# Usage:
#   ./test-auto-route.sh [--business] [--proxy-url URL] [--prompt TEXT] [--max-output N] [--skip-final] [--show-headers]
#
# Examples:
#   ./test-auto-route.sh --prompt "Reply with exactly: hi"
#   ./test-auto-route.sh --business --prompt "Design a robust distributed transaction coordinator"

set -euo pipefail

PROXY_URL="http://localhost:4141"
COPILOT_BASE="https://api.individual.githubcopilot.com"
PROMPT="Reply with exactly: hi"
MAX_OUTPUT=256
SKIP_FINAL=false
SHOW_HEADERS=false

COPILOT_VERSION="${COPILOT_VERSION:-0.44.1}"
VSCODE_VERSION="${VSCODE_VERSION:-1.116.0}"
AUTO_API_VERSION="${AUTO_API_VERSION:-2025-07-16}"
EDITOR_PLUGIN_VERSION="copilot-chat/${COPILOT_VERSION}"
USER_AGENT="GitHubCopilotChat/${COPILOT_VERSION}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --business)
      COPILOT_BASE="https://api.business.githubcopilot.com"
      shift
      ;;
    --proxy-url)
      PROXY_URL="$2"
      shift 2
      ;;
    --prompt)
      PROMPT="$2"
      shift 2
      ;;
    --max-output)
      MAX_OUTPUT="$2"
      shift 2
      ;;
    --skip-final)
      SKIP_FINAL=true
      shift
      ;;
    --show-headers)
      SHOW_HEADERS=true
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

COPILOT_TOKEN=$(curl -s "$PROXY_URL/token" | jq -r '.token')
if [[ -z "$COPILOT_TOKEN" || "$COPILOT_TOKEN" == "null" ]]; then
  echo "ERROR: Failed to get Copilot token from $PROXY_URL/token" >&2
  exit 1
fi

REQUEST_ID_BASE="auto-$(cat /proc/sys/kernel/random/uuid)"

common_headers=(
  -H "Authorization: Bearer $COPILOT_TOKEN"
  -H "content-type: application/json"
  -H "copilot-integration-id: vscode-chat"
  -H "editor-version: vscode/${VSCODE_VERSION}"
  -H "editor-plugin-version: ${EDITOR_PLUGIN_VERSION}"
  -H "user-agent: ${USER_AGENT}"
  -H "openai-intent: conversation-agent"
  -H "x-github-api-version: ${AUTO_API_VERSION}"
  -H "X-Initiator: agent"
)

session_body='{"auto_mode":{"model_hints":["auto"]}}'
SESSION_HEADERS=$(mktemp)
session_json=$(curl -sS -D "$SESSION_HEADERS" "$COPILOT_BASE/models/session" \
  "${common_headers[@]}" \
  -H "x-request-id: ${REQUEST_ID_BASE}-session" \
  -d "$session_body")

echo "=== Session Response ==="
if [[ "$SHOW_HEADERS" == "true" ]]; then
  echo "--- Session Headers ---"
  cat "$SESSION_HEADERS"
  echo
fi
echo "$session_json" | jq .

session_token=$(echo "$session_json" | jq -r '.session_token')
available_models=$(echo "$session_json" | jq -c '.available_models')
selected_model=$(echo "$session_json" | jq -r '.selected_model')

if [[ -z "$session_token" || "$session_token" == "null" ]]; then
  echo "ERROR: session_token missing from /models/session response" >&2
  exit 1
fi

prompt_len=$(printf '%s' "$PROMPT" | python3 -c 'import sys; print(len(sys.stdin.read()))')
intent_body=$(jq -nc \
  --arg prompt "$PROMPT" \
  --argjson available_models "$available_models" \
  --argjson prompt_char_count "$prompt_len" \
  '{prompt: $prompt, available_models: $available_models, turn_number: 1, prompt_char_count: $prompt_char_count}')

INTENT_HEADERS=$(mktemp)
intent_json=$(curl -sS -D "$INTENT_HEADERS" "$COPILOT_BASE/models/session/intent" \
  "${common_headers[@]}" \
  -H "Copilot-Session-Token: $session_token" \
  -H "x-request-id: ${REQUEST_ID_BASE}-intent" \
  -d "$intent_body")

echo
echo "=== Intent Response ==="
if [[ "$SHOW_HEADERS" == "true" ]]; then
  echo "--- Intent Headers ---"
  cat "$INTENT_HEADERS"
  echo
fi
echo "$intent_json" | jq .

chosen_model=$(echo "$intent_json" | jq -r '.chosen_model')
if [[ -z "$chosen_model" || "$chosen_model" == "null" ]]; then
  echo "ERROR: chosen_model missing from /models/session/intent response" >&2
  exit 1
fi

if [[ "$SKIP_FINAL" == "true" ]]; then
  exit 0
fi

echo
echo "=== Final Request ==="
if [[ "$chosen_model" == claude-* ]]; then
  final_url="$COPILOT_BASE/v1/messages"
  final_body=$(jq -nc \
    --arg model "$chosen_model" \
    --arg prompt "$PROMPT" \
    --argjson max_tokens "$MAX_OUTPUT" \
    '{model: $model, max_tokens: $max_tokens, stream: false, messages: [{role: "user", content: $prompt}]}')
elif [[ "$chosen_model" == gpt-5* ]]; then
  final_url="$COPILOT_BASE/v1/responses"
  final_body=$(jq -nc \
    --arg model "$chosen_model" \
    --arg input "$PROMPT" \
    --argjson max_output_tokens "$MAX_OUTPUT" \
    '{model: $model, input: $input, max_output_tokens: $max_output_tokens, stream: false}')
else
  final_url="$COPILOT_BASE/chat/completions"
  final_body=$(jq -nc \
    --arg model "$chosen_model" \
    --arg prompt "$PROMPT" \
    --argjson max_tokens "$MAX_OUTPUT" \
    '{model: $model, max_tokens: $max_tokens, stream: false, messages: [{role: "user", content: $prompt}]}')
fi

echo "$final_body" | jq .

FINAL_HEADERS=$(mktemp)
final_json=$(curl -sS -D "$FINAL_HEADERS" "$final_url" \
  "${common_headers[@]}" \
  -H "Copilot-Session-Token: $session_token" \
  -H "x-request-id: ${REQUEST_ID_BASE}-final" \
  -d "$final_body")

echo
echo "=== Final Response ==="
if [[ "$SHOW_HEADERS" == "true" ]]; then
  echo "--- Final Headers ---"
  cat "$FINAL_HEADERS"
  echo
fi
echo "$final_json" | jq .

echo
echo "=== Extracted Summary ==="
echo "$final_json" | jq -r '
  if .content then
    { endpoint: "messages", text: ([.content[]? | select(.type == "text") | .text] | join("")) }
  elif .choices then
    { endpoint: "chat/completions", text: .choices[0].message.content }
  else
    {
      endpoint: "responses",
      text: (
        [
          .output_text?,
          (.output[]? | select(.type == "message") | .content[]? | select(.type == "output_text") | .text)
        ]
        | map(select(. != null and . != ""))
        | unique
        | join("\n")
      ),
      incomplete_reason: .incomplete_details.reason?
    }
  end'

rm -f "$SESSION_HEADERS" "$INTENT_HEADERS" "$FINAL_HEADERS"
