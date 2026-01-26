#!/bin/bash
MODEL="${1:-gpt-4.1}"

curl -N -s http://localhost:4142/v1/messages \
  -H "content-type: application/json" \
  -d '{
    "model": "'"$MODEL"'",
    "max_tokens": 20000,
    "stream": true,
    "thinking": {
      "type": "enabled",
      "budget_tokens": 16000
    },
    "messages": [
      {"role": "user", "content": "Speak Chinese then Say hello in 3 languages, briefly."}
    ]
  }'
