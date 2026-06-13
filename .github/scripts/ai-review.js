const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { GoogleGenAI, Type } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// THIẾT KẾ SCHEMA MỚI: TẬP TRUNG HOÀN TOÀN VÀO INLINE COMMENTS THEO DÒNG CODE
const ResponseSchema = {
  type: Type.OBJECT,
  properties: {
    action_type: { 
      type: Type.STRING, 
      description: "Bắt buộc chọn: 'suggest_ui' (nếu phát hiện có lỗi cấu hình/bảo mật cần sửa trên dòng code) hoặc 'comment_only' (nếu code sạch hoàn toàn)." 
    },
    pr_description: {
      type: Type.OBJECT,
      description: "Cấu trúc thông tin dùng để cập nhật Description chính của PR nếu người dùng yêu cầu.",
      properties: {
        what_changed: { type: Type.STRING },
        benefit: { type: Type.STRING },
        testcases: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              testcase_name: { type: Type.STRING },
              status: { type: Type.STRING, description: "Bắt buộc: 'Đã test' hoặc 'Chưa test'" },
              notes: { type: Type.STRING }
            },
            required: ["testcase_name", "status"]
          }
        }
      },
      required: ["what_changed", "benefit", "testcases"]
    },
    mermaid_diagram: { type: Type.STRING, description: "Sơ đồ Mermaid thể hiện luồng hệ thống." },
    // CHUYỂN ĐỒI TOÀN BỘ SEVERITY VÀ CODESUGGEST VÀO MỘT MẢNG INLINE COMMENTS
    inline_reviews: {
      type: Type.ARRAY,
      description: "Danh sách tất cả các vị trí mã nguồn phát hiện lỗi bảo mật, sai quy chuẩn hoặc cần tối ưu cấu hình.",
      items: {
        type: Type.OBJECT,
        properties: {
          path: { type: Type.STRING, description: "Đường dẫn file chính xác (ví dụ: ansible/roles/argocd/tasks/main.yml)." },
          start_line: { type: Type.INTEGER, description: "Dòng bắt đầu lỗi trong file mới." },
          end_line: { type: Type.INTEGER, description: "Dòng kết thúc lỗi trong file mới." },
          severity: { type: Type.STRING, description: "Bắt buộc chọn mức độ rủi ro của lỗi này: high | medium | low" },
          title: { type: Type.STRING, description: "Tên ngắn gọn của lỗi (Ví dụ: Hardcoded Password, Missing CPU/Memory Limits)." },
          comment: { type: Type.STRING, description: "Giải thích chi tiết tại sao dòng code này chưa ổn và rủi ro ảnh hưởng hệ thống là gì." },
          suggested_code: { type: Type.STRING, description: "Đoạn mã hoàn chỉnh thay thế dòng cũ để tối ưu đạt chuẩn Best Practice." }
        },
        required: ["path", "start_line", "end_line", "severity", "title", "comment", "suggested_code"]
      }
    }
  },
  required: ["action_type", "pr_description", "mermaid_diagram", "inline_reviews"]
};

function buildLiveRepositoryContext(dirPath, extFilter = ['.yml', '.yaml', '.cfg', 'Vagrantfile', '.tpl'], maxLen = 120000) {
  let contextText = "=== REPOSITORY LIVE CONTEXT ===\n";
  function walk(currentDir) {
    if (contextText.length >= maxLen) return;
    const files = fs.readdirSync(currentDir);
    for (const file of files) {
      if (file === 'node_modules' || file === '.git' || file === '.github') continue;
      const fullPath = path.join(currentDir, file);
      if (fs.statSync(fullPath).isDirectory()) { walk(fullPath); } 
      else {
        if (extFilter.some(ext => file.endsWith(ext) || file === ext)) {
          contextText += `\n--- FILE: ${fullPath} ---\n`;
          let content = fs.readFileSync(fullPath, 'utf8');
          content = content.replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED_KEY]');
          content = content.replace(/\b(password|secret|token|api[_-]?key)\b.*$/gim, '[REDACTED_LINE]');
          contextText += content + "\n";
        }
      }
    }
  }
  try { walk(dirPath); } catch (err) {}
  return contextText.slice(0, maxLen);
}

async function run() {
  const prNumber = process.env.PR_NUMBER;
  const rawComment = process.env.USER_COMMENT || '';
  const repo = process.env.GITHUB_REPOSITORY;

  const lowerComment = rawComment.toLowerCase();
  const isDescriptionRequested = lowerComment.includes('description') || lowerComment.includes('desc') || lowerComment.includes('mô tả');

  let baseRef = 'main';
  try {
    const detected = execSync(`gh pr view ${prNumber} --json baseRefName --jq .baseRefName`).toString().trim();
    if (detected) baseRef = detected;
  } catch (e) {}

  try { execSync(`git fetch origin ${baseRef}`, { stdio: 'ignore' }); } catch (e) {}
  const prDiff = execSync(`git diff origin/${baseRef}...HEAD`).toString();
  const sourceContext = buildLiveRepositoryContext(process.cwd());

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { text: "Bạn là một Chuyên gia DevOps Senior phụ trách review tự động. Bạn phân tích Git Diff và bắt buộc phải gán nhãn mức độ Severity (high/medium/low) kèm code sửa đổi trực tiếp vào từng dòng lỗi trong mảng inline_reviews." },
          { text: `${sourceContext}\n\nĐoạn mã thay đổi của PR hiện tại (Diff):\n${prDiff}\n\nLời nhắn từ user: ${rawComment}` }
        ]
      }
    ],
    config: { responseMimeType: "application/json", responseSchema: ResponseSchema, temperature: 0.1 }
  });

  let result = null;
  try { result = JSON.parse(response.text); } catch (err) { process.exit(1); }

  // ================= 1. PR DESCRIPTION =================
  if (isDescriptionRequested) {
    const descData = result.pr_description;
    let testcaseTable = `| STT | 🧪 Kịch Bản Kiểm Thử (Test Case) | 📊 Trạng Thái | 📝 Ghi Chú |\n| :---: | :--- | :---: | :--- |\n`;
    if (descData.testcases && descData.testcases.length > 0) {
      descData.testcases.forEach((tc, idx) => {
        const icon = tc.status === 'Đã test' ? '`✅ Đã kiểm thử`' : '`❌ Chưa kiểm thử`';
        testcaseTable += `| ${idx + 1} | **${tc.testcase_name}** | ${icon} | ${tc.notes || '_No notes_'} |\n`;
      });
    }
    const updatedPrBody = `## 📑 1. WHAT CHANGED (Nội dung thay đổi)\n${descData.what_changed}\n\n## 🎯 2. BENEFIT (Giá trị & Lợi ích mang lại)\n> 💡 **Tác động hệ thống:**\n> ${descData.benefit}\n\n## 🧪 3. TESTCASES (Trạng thái ma trận kiểm thử)\n${testcaseTable}\n\n---\n*⚡ Báo cáo tóm tắt PR này được cập nhật tự động theo yêu cầu của Lập trình viên.*`;
    fs.writeFileSync('pr_body.md', updatedPrBody);
    try { execSync(`gh pr edit ${prNumber} --body-file=pr_body.md`); } catch (e) {}
  }

  // ================= 2. MERMAID DIAGRAM CONVERSATION (KHÔNG CÒN BẢNG SEVERITY) =================
  let mermaidSection = '';
  if (result.mermaid_diagram && result.mermaid_diagram.trim().length > 0) {
    mermaidSection = `### 🗺️ SƠ ĐỒ BIẾN ĐỔI KIẾN TRÚC HỆ THỐNG (ASIS ➡️ TOBE)\n\`\`\`mermaid\n${result.mermaid_diagram.replace(/```mermaid/g, '').replace(/```/g, '').trim()}\n\`\`\``;
  }

  // Stable marker so we update the same conversation comment instead of creating new ones
  const COMMENT_MARKER = '<!-- AI-COMPOSITE-MERMAID-MARKER -->';
  const commentIdentifier = COMMENT_MARKER;
  const fullCommentBody = `${commentIdentifier}\n# BÁO CÁO PHÂN TÍCH HỆ THỐNG (tóm tắt)\n\n${mermaidSection}\n\n> Cập nhật: \`${new Date().toLocaleString('vi-VN')}\``;

  let existingCommentId = null;
  try {
    const commentsRaw = execSync(`gh pr view ${prNumber} --json comments --jq .comments`, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (commentsRaw) {
      const comments = JSON.parse(commentsRaw);
      const botComment = comments.find(c => c.body && c.body.includes("AI-COMPOSITE-MERMAID-MARKER"));
      if (botComment) existingCommentId = botComment.id;
    }
  } catch (e) {}

  if (existingCommentId) {
    try {
      execSync(`gh api -X PATCH /repos/${repo}/issues/comments/${existingCommentId} -f body="${fullCommentBody.replace(/"/g, '\\"')}"`);
    } catch (patchErr) {
      fs.writeFileSync('conversation_comment.md', fullCommentBody);
      execSync(`gh pr comment ${prNumber} --body-file=conversation_comment.md`);
    }
  } else {
    fs.writeFileSync('conversation_comment.md', fullCommentBody);
    execSync(`gh pr comment ${prNumber} --body-file=conversation_comment.md`);
  }

  // ================= 3. ĐẨY LỖI SEVERITY VÀ CODESUGGEST TRỰC TIẾP VÀO TỪNG DÒNG FILE CHANGES =================
  if (result.action_type === 'suggest_ui' && result.inline_reviews && result.inline_reviews.length > 0) {
    console.log(`Found ${result.inline_reviews.length} inline review(s) from AI.`);
    try {
      const prFilesRaw = execSync(`gh api -H "Accept: application/vnd.github+json" /repos/${repo}/pulls/${prNumber}/files`).toString();
      const prFiles = JSON.parse(prFilesRaw);

      // Fetch existing inline review comments on the PR to avoid duplicates
      let existingInline = [];
      try {
        const existingRaw = execSync(`gh api -H "Accept: application/vnd.github+json" /repos/${repo}/pulls/${prNumber}/comments`).toString();
        existingInline = JSON.parse(existingRaw);
      } catch (e) {
        existingInline = [];
      }

      function normalizeText(s) {
        if (!s) return '';
        // remove suggestion fences and code fences, normalize whitespace and lowercase
        return s
          .replace(/```suggestion[\s\S]*?```/g, '')
          .replace(/```[\s\S]*?```/g, '')
          .replace(/[`~!@#$%^&*()\-_=+\[\]{};:'"\\|,<.>/?]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
      }

      function tokenize(s) {
        const n = normalizeText(s);
        if (!n) return [];
        return Array.from(new Set(n.split(/\s+/).filter(Boolean)));
      }

      function tokenSimilarity(a, b) {
        const ta = tokenize(a);
        const tb = tokenize(b);
        if (ta.length === 0 || tb.length === 0) return 0;
        let inter = 0;
        const setB = new Set(tb);
        ta.forEach(t => { if (setB.has(t)) inter += 1; });
        return inter / Math.min(ta.length, tb.length);
      }

      function alreadyPosted(review) {
        if (!existingInline || existingInline.length === 0) return false;
        const snippet = (review.suggested_code || '').slice(0, 240).trim();
        return existingInline.some(c => {
          try {
            if (!c.path) return false;
            if (c.path !== review.path && c.path !== review.path.replace(/^\//, '')) return false;
            const bodyNorm = normalizeText(c.body || '');
            // 1) exact title match
            if (review.title && bodyNorm.includes(review.title.toLowerCase())) return true;
            // 2) snippet exact
            if (snippet && bodyNorm.includes(normalizeText(snippet))) return true;
            // 3) token similarity check between suggested code and existing comment body
            if (snippet) {
              const sim = tokenSimilarity(snippet, bodyNorm);
              if (sim >= 0.6) return true; // 60% token overlap considered duplicate
            }
            // 4) also check similarity between review.comment and existing body
            if (review.comment) {
              const sim2 = tokenSimilarity(review.comment, bodyNorm);
              if (sim2 >= 0.6) return true;
            }
            return false;
          } catch (e) { return false; }
        });
      }
      const commentsPayload = [];

      // Auto-apply small fixes heuristic: if the suggested change is small (<= 10 lines)
      // and the target file exists in workspace, apply it locally and prepare a commit message.
      const autoApplied = [];

      function safeApplySuggestion(review) {
        try {
          const targetPath = path.join(process.cwd(), review.path.replace(/^\//, ''));
          if (!fs.existsSync(targetPath)) return false;
          const fileContent = fs.readFileSync(targetPath, 'utf8').split('\n');
          const start = Number(review.start_line) || Number(review.end_line) || 1;
          const end = Number(review.end_line) || start;
          const suggestedLines = (review.suggested_code || '').replace(/\r\n/g, '\n').split('\n');
          const linesToReplace = Math.max(1, end - start + 1);
          if (suggestedLines.length > 10 || linesToReplace > 20) return false; // too big

          // 1-indexed to 0-indexed
          const before = fileContent.slice(0, start - 1);
          const after = fileContent.slice(end);
          const newContent = before.concat(suggestedLines).concat(after).join('\n');
          fs.writeFileSync(targetPath, newContent, 'utf8');
          autoApplied.push({ path: review.path, start, end, lines: suggestedLines.length });
          return true;
        } catch (e) {
          return false;
        }
      }

      result.inline_reviews.forEach(review => {
        // Skip if we've already posted the same or similar suggestion on this PR
        if (alreadyPosted(review)) {
          console.log(`Skipping duplicate review for ${review.path} - ${review.title || '[no title]'}`);
          return;
        }
        // Định dạng nhãn Severity bắt mắt trực tiếp trong hội thoại của dòng code
        let sevLabel = review.severity === 'high' ? '🛑 [HIGH]' : review.severity === 'medium' ? '🟡 [MEDIUM]' : '🟢 [LOW]';

        // Minimal inline suggestion body — avoid leader/marketing phrases. Put severity, short reason and suggestion.
        const inlineBody = `${sevLabel} - ${review.title}\n> ${review.comment}\n\n\`\`\`suggestion\n${review.suggested_code}\n\`\`\``;

        // Try to auto-apply small fixes; if applied, note it in the inline body
        const wasAuto = safeApplySuggestion(review);
        const appliedNote = wasAuto ? '\n*(Auto-applied by AI: small/syntax fix — change committed)*' : '';
        const inlineBodyFinal = inlineBody + appliedNote;

        let mappedPosition = null;
        const fileObj = prFiles.find(f => f.filename === review.path || f.filename === review.path.replace(/^\//, ''));
        if (fileObj && fileObj.patch) {
          mappedPosition = mapLineToDiffPosition(fileObj.patch, Number(review.end_line) || Number(review.start_line) || 1);
        }

        const usePosition = mappedPosition || Number(review.end_line) || 1;
        commentsPayload.push({
          path: review.path,
          position: usePosition,
          body: inlineBodyFinal
        });
      });

      // If we auto-applied any fixes, write a concise commit message for the composite action to pick up
      if (autoApplied.length > 0) {
        const lines = ['AI auto-applied small fixes:', ''];
        autoApplied.forEach((a, idx) => {
          lines.push(`- ${a.path}: replaced lines ${a.start}-${a.end} (new ${a.lines} lines)`);
        });
        fs.writeFileSync('commit_msg.txt', lines.join('\n'));
      }

      const reviewPayload = {
        body: "📢 **AI Reviewer phát hiện lỗi bảo mật / sai quy chuẩn cấu hình trực tiếp trên các dòng code sau:**",
        event: "COMMENT",
        comments: commentsPayload
      };

      fs.writeFileSync('review_payload.json', JSON.stringify(reviewPayload));
      const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      execSync(`curl -s -X POST -H "Authorization: token ${ghToken}" -H "Accept: application/vnd.github+json" -H "Content-Type: application/json" -d @review_payload.json https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`);
      console.log("✅ Đã ghim toàn bộ Severity và Code Suggestion thành công vào tab Files changed.");
    } catch (err) {
      console.error("Lỗi khi ghim review comments:", err.message);
    }
  }

  // Thu dọn file tạm
  ['pr_body.md', 'conversation_comment.md', 'review_payload.json'].forEach(f => {
    try { fs.unlinkSync(f); } catch (e) {}
  });
}

function mapLineToDiffPosition(filePatch, targetLine) {
  if (!filePatch) return null;
  const lines = filePatch.split('\n');
  let position = 0, curNew = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]; position += 1;
    const hunkMatch = line.match(/^@@ \-(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) { curNew = parseInt(hunkMatch[3], 10); continue; }
    if (line.startsWith('+')) { if (curNew === targetLine) return position; curNew += 1; }
    else if (!line.startsWith('-')) { if (curNew === targetLine) return position; curNew += 1; }
  }
  return null;
}

run().catch(err => { process.exit(1); });
