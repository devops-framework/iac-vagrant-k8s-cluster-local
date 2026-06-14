const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { GoogleGenAI, Type } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
    mermaid_diagram: { 
      type: Type.STRING, 
      // ✅ ĐÃ CẢI TIẾN: Ràng buộc chặt chẽ trong Schema để mô hình không sinh ra nháy kép gây lỗi render
      description: "Sơ đồ Mermaid thể hiện luồng hệ thống. CHÚ Ý QUAN TRỌNG: Để tránh lỗi biên dịch cú pháp Mermaid, TUYỆT ĐỐI không sử dụng ký tự nháy kép (\") bên trong nhãn của các Node (ví dụ: viết E[Add 'Eyes' Reaction] hoặc E[Add Eyes Reaction] thay vì E[Add \"Eyes\" Reaction])." 
    },
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

function buildLiveRepositoryContext(dirPath, extFilter = ['.yml', '.yaml', '.cfg', 'Vagrantfile', '.tpl'], maxLen = 120000, maxFileBytes = 204800) {
  let contextText = "=== REPOSITORY LIVE CONTEXT ===\n";
  const skippedFiles = [];
  let filesAdded = 0;
  let filesConsidered = 0;
  function walk(currentDir) {
    if (contextText.length >= maxLen) return;
    const files = fs.readdirSync(currentDir);
    for (const file of files) {
      if (file === 'node_modules' || file === '.git' || file === '.github') continue;
      const fullPath = path.join(currentDir, file);
      if (fs.statSync(fullPath).isDirectory()) { walk(fullPath); } 
      else {
        if (extFilter.some(ext => file.endsWith(ext) || file === ext)) {
          filesConsidered += 1;
          try {
            const size = fs.statSync(fullPath).size;
            if (size > maxFileBytes) {
              contextText += `\n--- FILE: ${fullPath} (skipped, size ${size} bytes) ---\n`;
              skippedFiles.push({ path: fullPath, size });
              continue;
            }
          } catch (e) {
            continue;
          }

          contextText += `\n--- FILE: ${fullPath} ---\n`;
          let content = fs.readFileSync(fullPath, 'utf8');
          content = content.replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED_KEY]');
          content = content.replace(/\b(password|secret|token|api[_-]?key)\b.*$/gim, '[REDACTED_LINE]');
          contextText += content + "\n";
          filesAdded += 1;
        }
      }
    }
  }
  try { walk(dirPath); } catch (err) {}
  return {
    context: contextText.slice(0, maxLen),
    stats: { filesAdded, filesConsidered, filesSkipped: skippedFiles.length, skippedFiles }
  };
}

async function run() {
  const prNumber = process.env.PR_NUMBER;
  const rawComment = process.env.USER_COMMENT || '';
  const repo = process.env.GITHUB_REPOSITORY;

  // Cấu hình môi trường bảo mật token để gh CLI luôn được xác thực trong execSync
  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const ghEnv = ghToken ? `GH_TOKEN=${ghToken} ` : '';

  const lowerComment = rawComment.toLowerCase();
  const isDescriptionRequested = lowerComment.includes('description') || lowerComment.includes('desc') || lowerComment.includes('mô tả');

  let baseRef = 'main';
  try {
    const detected = execSync(`${ghEnv}gh pr view ${prNumber} --json baseRefName --jq .baseRefName`).toString().trim();
    if (detected) baseRef = detected;
  } catch (e) {}

  try { execSync(`git fetch origin ${baseRef}`, { stdio: 'ignore' }); } catch (e) {}
  const prDiff = execSync(`git diff origin/${baseRef}...HEAD`).toString();
  const maxFileBytes = Number(process.env.MAX_FILE_BYTES || '204800');
  const includeMetrics = (process.env.INCLUDE_METRICS || 'true').toLowerCase() === 'true';
  const ctxResult = buildLiveRepositoryContext(process.cwd(), undefined, 120000, maxFileBytes);
  const sourceContext = ctxResult.context;
  const contextStats = ctxResult.stats;

  const responseAI = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          // ✅ ĐÃ CẢI TIẾN: Bổ sung chỉ thị loại trừ ký tự nháy kép (\") trong prompt hệ thống để Gemini chú ý hơn
          { text: "Bạn là một Chuyên gia DevOps Senior phụ trách review tự động. Bạn phân tích Git Diff và bắt buộc phải gán nhãn mức độ Severity (high/medium/low) kèm code sửa đổi trực tiếp vào từng dòng lỗi trong mảng inline_reviews. QUY TẮC MERMAID: Không bao giờ sử dụng dấu nháy kép (\") hoặc các ký tự đặc biệt làm gãy cú pháp bên trong nhãn node (ví dụ: dùng nháy đơn E[Add 'Eyes' Reaction] hoặc viết thường E[Add Eyes Reaction])." },
          { text: `${sourceContext}\n\nĐoạn mã thay đổi của PR hiện tại (Diff):\n${prDiff}\n\nLời nhắn từ user: ${rawComment}` }
        ]
      }
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: ResponseSchema,
      temperature: 0.1
    }
  });

  const rawText = responseAI.text;
  if (!rawText) {
    console.error("❌ AI không trả về kết quả hợp lệ.");
    process.exit(1);
  }

  let result = null;
  try {
    const cleanJson = rawText.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    result = JSON.parse(cleanJson);
  } catch (err) {
    console.error("❌ Không thể phân tích JSON từ AI.");
    console.error("Nội dung gốc AI trả về:", rawText);
    process.exit(1);
  }

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
    try { execSync(`${ghEnv}gh pr edit ${prNumber} --body-file=pr_body.md`); } catch (e) {}
  }

  // ================= 2. MERMAID DIAGRAM CONVERSATION =================
  let mermaidSection = '';
  if (result.mermaid_diagram && result.mermaid_diagram.trim().length > 0) {
    mermaidSection = `### 🗺️ SƠ ĐỒ BIẾN ĐỔI KIẾN TRÚC HỆ THỐNG (ASIS ➡️ TOBE)\n\`\`\`mermaid\n${result.mermaid_diagram.replace(/```mermaid/g, '').replace(/```/g, '').trim()}\n\`\`\``;
  }

  const COMMENT_MARKER = '<!-- AI-COMPOSITE-MERMAID-MARKER -->';
  const fullCommentBody = `${COMMENT_MARKER}\n# BÁO CÁO PHÂN TÍCH HỆ THỐNG (tóm tắt)\n\n${mermaidSection}\n\n> Cập nhật: \`${new Date().toLocaleString('vi-VN')}\``;

  let existingCommentId = null;
  try {
    // Thay thế "gh pr view" bằng "gh api" để lấy danh sách bình luận chứa ID số nguyên (REST ID) thay vì ID GraphQL
    const commentsRaw = execSync(`${ghEnv}gh api /repos/${repo}/issues/${prNumber}/comments`, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (commentsRaw) {
      const comments = JSON.parse(commentsRaw);
      const botComment = comments.find(c => c.body && c.body.includes("AI-COMPOSITE-MERMAID-MARKER"));
      if (botComment) existingCommentId = botComment.id;
    }
  } catch (e) {}

  if (existingCommentId) {
    const patchJsonPayload = 'summary_patch.json';
    fs.writeFileSync(patchJsonPayload, JSON.stringify({ body: fullCommentBody }));
    try {
      // Sử dụng --input cùng ID số nguyên chính xác để PATCH comment mà không bị lỗi 404
      execSync(`${ghEnv}gh api -X PATCH /repos/${repo}/issues/comments/${existingCommentId} --input ${patchJsonPayload}`);
    } catch (patchErr) {
      const commentFile = 'conversation_comment.md';
      fs.writeFileSync(commentFile, fullCommentBody);
      execSync(`${ghEnv}gh pr comment ${prNumber} --body-file=${commentFile}`);
      try { fs.unlinkSync(commentFile); } catch (e) {}
    }
    try { fs.unlinkSync(patchJsonPayload); } catch (e) {}
  } else {
    const commentFile = 'conversation_comment.md';
    fs.writeFileSync(commentFile, fullCommentBody);
    execSync(`${ghEnv}gh pr comment ${prNumber} --body-file=${commentFile}`);
    try { fs.unlinkSync(commentFile); } catch (e) {}
  }

  if (result.action_type === 'comment_only') {
    try {
      let metricsSection = '';
      if (includeMetrics && contextStats) {
        metricsSection = `\n\nFiles scanned: ${contextStats.filesConsidered}, files added to context: ${contextStats.filesAdded}, files skipped: ${contextStats.filesSkipped}`;
      }

      const cleanSummary = `${COMMENT_MARKER}\n# BÁO CÁO PHÂN TÍCH HỆ THỐNG (tóm tắt)\n\n${mermaidSection}\n\n✅ No issues found by automated review.${metricsSection}\n\nCập nhật: \`${new Date().toLocaleString('vi-VN')}\``;
      
      if (existingCommentId) {
        const cleanJsonPayload = 'clean_summary.json';
        fs.writeFileSync(cleanJsonPayload, JSON.stringify({ body: cleanSummary }));
        execSync(`${ghEnv}gh api -X PATCH /repos/${repo}/issues/comments/${existingCommentId} --input ${cleanJsonPayload}`);
        try { fs.unlinkSync(cleanJsonPayload); } catch (e) {}
      } else {
        const cleanFile = 'clean_summary.tmp.md';
        fs.writeFileSync(cleanFile, cleanSummary);
        execSync(`${ghEnv}gh pr comment ${prNumber} --body-file=${cleanFile}`);
        try { fs.unlinkSync(cleanFile); } catch (e) {}
      }

      try {
        execSync(`${ghEnv}gh api -X POST /repos/${repo}/pulls/${prNumber}/reviews -f body="✅ Automated AI review: no issues found." -f event=COMMENT`);
      } catch (e) {}
    } catch (e) {}
    return;
  }

  // ================= 3. ĐẨY LỖI SEVERITY VÀ CODESUGGEST TRỰC TIẾP VÀO TỪNG DÒNG =================
  if (result.action_type === 'suggest_ui' && result.inline_reviews && result.inline_reviews.length > 0) {
    console.log(`Found ${result.inline_reviews.length} inline review(s) from AI.`);
    try {
      const prFilesRaw = execSync(`${ghEnv}gh api -H "Accept: application/vnd.github+json" /repos/${repo}/pulls/${prNumber}/files`).toString();
      const prFiles = JSON.parse(prFilesRaw);

      let existingInline = [];
      try {
        const existingRaw = execSync(`${ghEnv}gh api -H "Accept: application/vnd.github+json" /repos/${repo}/pulls/${prNumber}/comments`).toString();
        existingInline = JSON.parse(existingRaw);
      } catch (e) {}

      function normalizeText(s) {
        if (!s) return '';
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

      function codeMatchesReason(review) {
        const suggested = (review.suggested_code || '').slice(0, 1000).trim();
        if (!suggested) return { matches: false, score: 0 };
        const comment = (review.comment || '').trim();
        const title = (review.title || '').trim();
        const sim1 = tokenSimilarity(suggested, comment);
        const sim2 = tokenSimilarity(suggested, title);
        const sim = Math.max(sim1, sim2);
        // ✅ ĐÃ SỬA: Tăng ngưỡng độ tương đồng từ 0.25 lên 0.5 để đảm bảo an toàn tối đa cho việc tự động áp dụng (auto-apply) gợi ý
        return { matches: sim >= 0.5, score: sim };
      }

      function alreadyPosted(review) {
        if (!existingInline || existingInline.length === 0) return false;
        const snippet = (review.suggested_code || '').slice(0, 240).trim();
        return existingInline.some(c => {
          try {
            if (!c.path) return false;
            if (c.path !== review.path && c.path !== review.path.replace(/^\//, '')) return false;
            const bodyNorm = normalizeText(c.body || '');
            if (review.title && bodyNorm.includes(review.title.toLowerCase())) return true;
            if (snippet && bodyNorm.includes(normalizeText(snippet))) return true;
            if (snippet) {
              const sim = tokenSimilarity(snippet, bodyNorm);
              if (sim >= 0.6) return true;
            }
            if (review.comment) {
              const sim2 = tokenSimilarity(review.comment, bodyNorm);
              if (sim2 >= 0.6) return true;
            }
            return false;
          } catch (e) { return false; }
        });
      }
      
      const commentsPayload = [];
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
          if (suggestedLines.length > 10 || linesToReplace > 20) return false;

          const before = fileContent.slice(0, start - 1);
          const after = fileContent.slice(end);
          const newContent = before.concat(suggestedLines).concat(after).join('\n');
          fs.writeFileSync(targetPath, newContent, 'utf8');
          autoApplied.push({ path: review.path, start, end, lines: suggestedLines.length });
          return true;
        } catch (e) { return false; }
      }

      result.inline_reviews.forEach(review => {
        if (alreadyPosted(review)) {
          console.log(`Skipping duplicate review for ${review.path} - ${review.title || '[no title]'}`);
          return;
        }
        let sevLabel = review.severity === 'high' ? '🛑 [HIGH]' : review.severity === 'medium' ? '🟡 [MEDIUM]' : '🟢 [LOW]';
        const inlineBody = `${sevLabel} - ${review.title}\n> ${review.comment}\n\n\`\`\`suggestion\n${review.suggested_code}\n\`\`\``;

        const matchInfo = codeMatchesReason(review);
        let wasAuto = false;
        if (matchInfo.matches) {
          wasAuto = safeApplySuggestion(review);
        }
        const appliedNote = wasAuto ? '\n*(Auto-applied by AI: small/syntax fix — change committed)*' : '';
        const cautionNote = !matchInfo.matches ? `\n\n⚠️ Caution: suggested code may not match the described issue (confidence=${matchInfo.score.toFixed(2)}). Please verify before applying.` : '';
        const inlineBodyFinal = inlineBody + appliedNote + cautionNote;

        commentsPayload.push({
          path: review.path,
          line: Number(review.end_line) || Number(review.start_line) || 1,
          side: "RIGHT",
          body: inlineBodyFinal
        });
      });

      if (autoApplied.length > 0) {
        const lines = ['AI auto-applied small fixes:', ''];
        autoApplied.forEach(a => {
          lines.push(`- ${a.path}: replaced lines ${a.start}-${a.end} (new ${a.lines} lines)`);
        });
        fs.writeFileSync('commit_msg.txt', lines.join('\n'));
      }

      const reviewPayload = {
        body: "📢 **Please check these comments**",
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

  try {
    if (typeof contextStats !== 'undefined' && contextStats) {
      console.log(`AI review context metrics: filesConsidered=${contextStats.filesConsidered}, filesAdded=${contextStats.filesAdded}, filesSkipped=${contextStats.filesSkipped}`);
    }
  } catch (e) {}

  ['pr_body.md', 'conversation_comment.md', 'review_payload.json'].forEach(f => {
    try { fs.unlinkSync(f); } catch (e) {}
  });
}

run().catch(err => {
  console.error("❌ Lỗi nghiêm trọng khi thực thi script:");
  console.error(err);
  process.exit(1);
});
