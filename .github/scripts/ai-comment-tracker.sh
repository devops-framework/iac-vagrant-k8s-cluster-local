#!/usr/bin/env bash

set -euo pipefail

# Nhận diện tham số từ biến môi trường (env) của Workflow
STAGE="${STAGE:-start}"              # "start" | "complete"
JOB_STATUS="${JOB_STATUS:-}"         # ""      | "success" | "failure"
COMMENT_ID="${COMMENT_ID:-}"
PR_NUMBER="${PR_NUMBER:-}"
RUN_ID="${GITHUB_RUN_ID:-}"
REPO="${REPO:-$GITHUB_REPOSITORY}"

# Kiểm tra sự tồn tại của Token bảo mật và các tham số cốt lõi
if [ -z "${GH_TOKEN:-}" ]; then
    echo "❌ [Tracker Error] Không tìm thấy biến môi trường GH_TOKEN."
    exit 1
fi

if [ -z "$COMMENT_ID" ] || [ -z "$PR_NUMBER" ] || [ -z "$RUN_ID" ]; then
    echo "❌ [Tracker Error] Thiếu tham số bắt buộc (COMMENT_ID, PR_NUMBER, RUN_ID)"
    exit 1
fi

WORKFLOW_URL="https://github.com/${REPO}/actions/runs/${RUN_ID}"
# Stable marker used to split user content from AI status block. Keep consistent with ai-review.js
MARKER='<!-- AI-COMPOSITE-MERMAID-MARKER -->'

# ================= VÒNG ĐỜI XỬ LÝ THEO STAGE =================

if [[ "$STAGE" == "start" ]]; then
    echo "👀 [Stage: Start] Thả emoji mắt và ghi trạng thái tạm thời..."
    
    # 1. Thả emoji mắt 👀 vào comment gốc của user
    gh api \
      -X POST \
      -H "Authorization: token $GH_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      /repos/${REPO}/issues/comments/${COMMENT_ID}/reactions \
      -f "content=eyes" > /dev/null

    # 2. Lấy nội dung gốc hiện tại của user từ GitHub API
    USER_ORIGINAL_BODY=$(gh api \
      -H "Accept: application/vnd.github+json" \
      /repos/${REPO}/issues/comments/${COMMENT_ID} \
      --jq '.body')

    # 3. Append an unobtrusive plain-text status block using Heredoc for safety
    UPDATED_BODY=$(cat <<EOF
${USER_ORIGINAL_BODY}

${MARKER}
---
AI Review: Receiving request
Status: Running
Progress: ${WORKFLOW_URL}
EOF
    )

    # 4. PATCH ghi đè trạng thái đang chạy lên chính comment đó
    jq -n --arg body "$UPDATED_BODY" '{body: $body}' > start_payload.json
    gh api \
      -X PATCH \
      -H "Authorization: token $GH_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      /repos/${REPO}/issues/comments/${COMMENT_ID} \
      --input start_payload.json > /dev/null
    rm start_payload.json

    echo "✅ Đã găm trạng thái đang chạy thành công."

elif [[ "$STAGE" == "complete" ]]; then
    echo "🏁 [Stage: Complete] Gỡ emoji mắt và ghi đè kết quả dứt điểm..."

    # 1. LOGIC XÓA REACTION CON MẮT 👀
    REACTION_ID=$(gh api \
      -H "Accept: application/vnd.github+json" \
      /repos/${REPO}/issues/comments/${COMMENT_ID}/reactions \
      --jq '.[] | select(.content == "eyes") | .id' | head -n 1)

    if [ -n "$REACTION_ID" ]; then
        gh api \
          -X DELETE \
          -H "Authorization: token $GH_TOKEN" \
          -H "Accept: application/vnd.github+json" \
          /repos/${REPO}/issues/comments/${COMMENT_ID}/reactions/${REACTION_ID} > /dev/null
        echo "✅ Đã gỡ bỏ emoji con mắt thành công."
    fi

    # 2. LẤY TOÀN BỘ NỘI DUNG HIỆN TẠI ĐỂ TIẾN HÀNH BÓC TÁCH CHUẨN XÁC
    CURRENT_FULL_BODY=$(gh api \
      -H "Accept: application/vnd.github+json" \
      /repos/${REPO}/issues/comments/${COMMENT_ID} \
      --jq '.body')

    # 3. Tách phần user original (phần trước marker). Nếu marker không tồn tại, giữ nguyên toàn bộ body.
    # Dùng file tạm để truyền dữ liệu vào node, tránh lỗi ARG_MAX hoặc lỗi shell quoting
    echo "$CURRENT_FULL_BODY" > current_body.tmp
    USER_CLEAN_BODY=$(node -e "
      const fs = require('fs');
      const fullBody = fs.readFileSync('current_body.tmp', 'utf8');
      const marker = '${MARKER}';
      if (fullBody.includes(marker)) {
        process.stdout.write(fullBody.split(marker)[0].trim());
      } else {
        process.stdout.write(fullBody.trim());
      }
    " 2>/dev/null || echo "$CURRENT_FULL_BODY")
    rm current_body.tmp

    # 4. THIẾT LẬP BLOCK HIỂN THỊ KẾT QUẢ CUỐI CÙNG
    if [[ "$JOB_STATUS" == "success" ]]; then
        echo "🎉 Cập nhật trạng thái hoàn thành THÀNH CÔNG..."
        FINAL_BODY=$(cat <<EOF
${USER_CLEAN_BODY}

${MARKER}
---
AI Review: Analysis completed
Status: SUCCESS
Workflow: ${WORKFLOW_URL}
EOF
        )
    elif [[ "$JOB_STATUS" == "failure" ]]; then
        echo "❌ Cập nhật trạng thái hoàn thành THẤT BẠI..."
        FINAL_BODY=$(cat <<EOF
${USER_CLEAN_BODY}

${MARKER}
---
AI Review: Analysis failed
Status: FAILURE
Details: ${WORKFLOW_URL}
EOF
        )
    else
        echo "❌ Trạng thái JOB_STATUS cung cấp không hợp lệ."
        exit 1
    fi

    # 5. GHI ĐÈ DỨT ĐIỂM LÊN COMMENT (Overwriting)
    jq -n --arg body "$FINAL_BODY" '{body: $body}' > final_payload.json
    gh api \
      -X PATCH \
      -H "Authorization: token $GH_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      /repos/${REPO}/issues/comments/${COMMENT_ID} \
      --input final_payload.json > /dev/null
    rm final_payload.json
      
    echo "🏁 Hoàn thành ghi đè trạng thái sạch sẽ không để lại vết lặp từ!"
fi
