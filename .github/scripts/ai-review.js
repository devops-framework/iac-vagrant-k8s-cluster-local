const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { GoogleGenAI, Type } = require('@google/genai');

// Khởi tạo Gemini client (Tự động bốc GEMINI_API_KEY từ env)
const ai = new GoogleGenAI();

// Định nghĩa cấu trúc Schema ép Gemini trả về JSON chuẩn 100%
const ResponseSchema = {
  type: Type.OBJECT,
  properties: {
    action_type: { 
      type: Type.STRING, 
      description: "Chỉ được chọn một trong hai giá trị: 'auto_commit' hoặc 'suggest_ui'" 
    },
    comment: { 
      type: Type.STRING, 
      description: "Nhận xét, giải thích kiến trúc hoặc hướng dẫn bằng Markdown gửi cho lập trình viên." 
    },
    commit_message: { 
      type: Type.STRING, 
      description: "Thông điệp commit (Conventional Commits) nếu chọn auto_commit. Nếu không cần thì để chuỗi rỗng." 
    },
    modified_files: {
      type: Type.ARRAY,
      description: "Danh sách file cần ghi đè hoàn toàn nội dung mới (Chỉ dùng khi action_type là 'auto_commit').",
      items: {
        type: Type.OBJECT,
        properties: {
          filepath: { type: Type.STRING },
          content: { type: Type.STRING }
        },
        required: ["filepath", "content"]
      }
    },
    suggestion_details: {
      type: Type.OBJECT,
      description: "Chi tiết khối code đề xuất ghim lên giao diện PR (Chỉ dùng khi action_type là 'suggest_ui').",
      properties: {
        path: { type: Type.STRING, description: "Đường dẫn file cần sửa." },
        start_line: { type: Type.INTEGER, description: "Dòng bắt đầu cần thay thế trong file gốc." },
        end_line: { type: Type.INTEGER, description: "Dòng kết thúc cần thay thế trong file gốc." },
        suggested_code: { type: Type.STRING, description: "Đoạn code mới hoàn toàn sẽ thay thế đoạn cũ từ start_line đến end_line." }
      },
      required: ["path", "start_line", "end_line", "suggested_code"]
    }
  },
  required: ["action_type", "comment", "commit_message", "modified_files", "suggestion_details"]
};

async function run() {
  const prNumber = process.env.PR_NUMBER;
  const rawComment = process.env.USER_COMMENT || '';
  // Workflow trigger uses '@tangpt'
  const userInstructions = rawComment.replace('@tangpt', '').trim();
  const repo = process.env.GITHUB_REPOSITORY;

  console.log("🚀 [DevOps Lead] Đang đọc Git Diff hiện tại của PR...");
  // Determine base branch dynamically via gh (safer than hardcoding 'main')
  let prDiff = '';
  let baseRef = 'main';
  try {
    const detected = execSync(`gh pr view ${prNumber} --json baseRefName --jq .baseRefName`).toString().trim();
    if (detected) baseRef = detected;
  } catch (e) {
    console.log('Không lấy được baseRef từ gh pr view, mặc định dùng "main"', e.message || e);
  }

  try {
    // ensure we have the base ref locally
    execSync(`git fetch origin ${baseRef}`, { stdio: 'ignore' });
  } catch (e) {
    console.log(`Không thể fetch origin/${baseRef}:`, e.message || e);
  }

  try {
    prDiff = execSync(`git diff origin/${baseRef}...HEAD`).toString();
  } catch (e) {
    console.log('git diff thất bại hoặc không có diff:', e.message || e);
    prDiff = '';
  }

  console.log("🔍 [DevOps Lead] Đang nạp Full Source Context từ GitHub Cache File...");
  let sourceContext = "Không tìm thấy dữ liệu nguồn.";
  if (fs.existsSync('source_context.txt')) {
    sourceContext = fs.readFileSync('source_context.txt', 'utf8');
    // redact private key blocks and obvious secrets
    sourceContext = sourceContext.replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  // Basic mask for common secrets keywords (case-insensitive, multiline)
  sourceContext = sourceContext.replace(/\b(password|secret|token|api[_-]?key|private[_-]?key)\b.*$/gim, '[REDACTED_SENSITIVE_LINE]');
    // Truncate to a safe maximum (150k chars)
    const MAX_CTX = 150000;
    if (sourceContext.length > MAX_CTX) {
      sourceContext = sourceContext.slice(0, MAX_CTX) + '\n\n[TRUNCATED_SOURCE_CONTEXT]';
    }
  }

  console.log("🧠 [DevOps Lead] Đang gửi dữ liệu (Tối ưu Double-Cache) sang Gemini 2.5 Flash...");

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    // Sắp xếp thứ tự để kích hoạt Prompt Caching của Google: Hệ thống + Full Source -> Đầu; Yêu cầu + Diff -> Cuối.
    contents: [
      {
        role: 'user',
        parts: [
          { text: "Bạn là một Senior DevOps Lead kiêm Kiến trúc sư phần mềm (Software Architect) lão luyện. Bạn có tư duy tối ưu hệ thống, bảo mật (DevSecOps), hiệu năng hạ tầng và đặc biệt am hiểu tường tận về Clean Architecture (phân tách rõ ràng giữa Entities, Use Cases, Interface Adapters, và Frameworks/Drivers)." },
          { text: `Dưới đây là TOÀN BỘ SOURCE CODE hiện tại của hệ thống được nạp từ bộ nhớ đệm để làm tài liệu hiểu kiến trúc gốc:\n\n${sourceContext}` },
          { text: `
            Hãy xử lý yêu cầu cụ thể này từ lập trình viên:
            [YÊU CẦU CỦA USER]: "${userInstructions || 'Hãy review toàn diện hệ thống, đối chiếu với PR và đưa ra giải pháp kiến trúc tối ưu.'}"
            
            [ĐOẠN GIT DIFF TRÊN PR]:
            \n${prDiff || 'Không có diff (Nhánh chưa có thay đổi so với main)'}

            QUY TẮC PHÂN LOẠI HÀNH VI ĐẦU RA (NGHIÊM NGẶT):
            TRƯỜNG HỢP 1: THAY ĐỔI ÍT, CỤC BỘ (Dưới 5 dòng, lỗi cú pháp, typo, cấu hình nhỏ hiển nhiên đúng và không phá vỡ Clean Architecture)
            - Đặt "action_type" là "auto_commit".
            - Viết lại nội dung file hoàn chỉnh ném vào mảng "modified_files".
            - Sinh commit message chuẩn Conventional Commits đặt vào "commit_message".

            TRƯỜNG HỢP 2: THAY ĐỔI PHỨC TẠP HOẶC KHÔNG TUÂN THỦ KIẾN TRÚC (Trên 5 dòng, code ảnh hưởng lan rộng giữa các tầng Clean Architecture, cần refactor, hoặc câu hỏi thảo luận hạ tầng)
            - Đặt "action_type" là "suggest_ui".
            - Giải thích rõ ràng lý do dưới góc nhìn kiến trúc hệ thống trong phần "comment".
            - Định vị chính xác file và dòng cần sửa, đưa đoạn code đề xuất vào "suggestion_details" để tạo giao diện nút bấm duyệt cho user.` 
          }
        ]
      }
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: ResponseSchema,
      temperature: 0.2 // Giảm độ sáng tạo để bốt phân tích code chính xác và nhất quán hơn
    }
  });

  let result;
  try {
    result = JSON.parse(response.text);
  } catch (err) {
    console.error('Không thể parse response từ model:', err);
    // post an informative comment to the PR and exit
    try {
      fs.writeFileSync('ai_error.md', 'AI trả về kết quả không hợp lệ. Vui lòng kiểm tra logs.');
      execSync(`gh pr comment ${prNumber} --body-file=ai_error.md`);
    } catch (e) {
      console.error('Không thể post lỗi lên PR:', e);
    }
    process.exit(1);
  }
  // result.comment will be written to files and posted via gh commands directly when needed

  // ================= XỬ LÝ KẾT QUẢ TỪ AI =================

  if (result.action_type === 'auto_commit') {
    console.log("=> [DevOps Lead] Kết quả: AUTO-COMMIT.");
    if (result.modified_files && result.modified_files.length > 0) {
      for (const file of result.modified_files) {
        // Prevent path traversal
        const normalized = path.normalize(file.filepath);
        if (normalized.startsWith('..')) {
          console.log('Rejected path traversal for', file.filepath);
          continue;
        }
        fs.mkdirSync(path.dirname(normalized), { recursive: true });
        fs.writeFileSync(normalized, file.content, 'utf8');
      }
      fs.writeFileSync('commit_msg.txt', result.commit_message || 'chore: apply ai suggested fixes');
    }
    // Create a PR-level comment as a reply (there is no issue comment /replies endpoint)
    try {
      fs.writeFileSync('reply.md', result.comment || 'Applied changes.');
      execSync(`gh pr comment ${prNumber} --body-file=reply.md`);
      // cleanup temp file
      try { fs.unlinkSync('reply.md'); } catch (e) { /* ignore */ }
    } catch (e) {
      console.log('Failed to post reply via gh pr comment, fallback to issue comment', e.message || e);
      try {
        execSync(`gh issue comment ${prNumber} -b "${result.comment || 'Applied changes.'}"`);
      } catch (ee) { /* best-effort */ }
    }
    // remove commit message file if present (commit already pushed or not needed)
    try { if (fs.existsSync('commit_msg.txt')) fs.unlinkSync('commit_msg.txt'); } catch (e) { /* ignore */ }

  } else if (result.action_type === 'suggest_ui') {
    console.log("=> [DevOps Lead] Kết quả: GHIM KHỐI SUGGESTION LÊN UI.");
    const sug = result.suggestion_details;
    const markdownSuggestion = `${result.comment || ''}\n\n\`\`\`suggestion\n${sug.suggested_code}\n\`\`\``;

    try {
      // Basic validation
      const normalized = path.normalize(sug.path || '');
      if (!sug.path || normalized.startsWith('..')) throw new Error('Invalid suggestion path');
      fs.writeFileSync('comment.md', markdownSuggestion);
      // Try to post an inline PR comment; position may fail if calculated incorrectly, fallback to PR-level comment
      try {
        execSync(`gh api -X POST /repos/${repo}/pulls/${prNumber}/comments -F body=@comment.md -F path=${sug.path} -F position=${sug.end_line}`);
        try { fs.unlinkSync('comment.md'); } catch (e) { /* ignore */ }
      } catch (inlineErr) {
        console.log('Inline comment failed, fallback to PR-level comment:', inlineErr.message || inlineErr);
        try { execSync(`gh pr comment ${prNumber} --body-file=comment.md`); } catch (e) { /* best-effort */ }
        try { fs.unlinkSync('comment.md'); } catch (e) { /* ignore */ }
      }
    } catch (apiError) {
      console.log('Failed to create suggestion, fallback to PR comment', apiError.message || apiError);
      fs.writeFileSync('comment.md', markdownSuggestion);
      try { execSync(`gh pr comment ${prNumber} --body-file=comment.md`); } catch (e) { /* best-effort */ }
    }
  }
}

run().catch(err => {
  console.error("❌ Sập hệ thống bốt Gemini DevOps Lead:", err);
  process.exit(1);
});
