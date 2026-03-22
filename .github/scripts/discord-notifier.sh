#!/bin/bash

WEBHOOK_URL=$1
STATUS=$2
TITLE_INPUT=$3
MESSAGE_INPUT=$4
RUN_URL=$5

# 1. Xác định màu sắc dựa trên status (vẫn giữ logic màu tự động cho chuyên nghiệp)
case "$STATUS" in
  success)   COLOR=4781122 ;;  # Green
  failure)   COLOR=14237451 ;; # Red
  cancelled) COLOR=15844367 ;; # Orange
  skipped)   COLOR=8421504 ;;  # Grey
  *)         COLOR=3447003 ;;  # Blue (Starting/Default)
esac

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 2. Đọc template và dùng 'sed' để thay thế các placeholder
# Sử dụng dấu | làm delimiter cho sed để tránh xung đột với ký tự / trong URL
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
TEMPLATE_FILE="$SCRIPT_DIR/../templates/discord-payload.json"
PAYLOAD=$(cat "$TEMPLATE_FILE")

sanitize() {
  local input="$1"
  # 1. Use jq to get a valid JSON string (handles quotes, backslashes, newlines)
  local json_str
  json_str=$(jq -n --arg s "$input" '$s')
  # 2. Strip surrounding quotes to get just the content
  local content="${json_str:1:-1}"
  # 3. Escape backslashes for sed (double them)
  content="${content//\\/\\\\}"
  # 4. Escape sed delimiter (|) and ampersand (&)
  content="${content//|/\\|}"
  content="${content//&/\\&}"
  echo "$content"
}

PAYLOAD=$(echo "$PAYLOAD" | sed "s|{{TITLE}}|$(sanitize "$TITLE_INPUT")|g")
PAYLOAD=$(echo "$PAYLOAD" | sed "s|{{COLOR}}|$COLOR|g")
PAYLOAD=$(echo "$PAYLOAD" | sed "s|{{CUSTOM_MESSAGE}}|$(sanitize "$MESSAGE_INPUT")|g")
PAYLOAD=$(echo "$PAYLOAD" | sed "s|{{RUN_URL}}|$(sanitize "$RUN_URL")|g")
PAYLOAD=$(echo "$PAYLOAD" | sed "s|{{TIMESTAMP}}|$TIMESTAMP|g")

# 3. Gửi qua curl
curl -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$WEBHOOK_URL"