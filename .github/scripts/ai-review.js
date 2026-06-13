const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { GoogleGenAI, Type } = require('@google/genai');

// Initialize Gemini client (reads GEMINI_API_KEY from env)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Define response schema to enforce strict JSON output from Gemini
const ResponseSchema = {
  type: Type.OBJECT,
  properties: {
    action_type: { 
      type: Type.STRING, 
      description: "One of: 'auto_commit' or 'suggest_ui'." 
    },
    comment: { 
      type: Type.STRING, 
      description: "Reviewer comment: architecture notes or instructions in Markdown for the author." 
    },
    commit_message: { 
      type: Type.STRING, 
      description: "Commit message (Conventional Commits) when auto_commit is selected. Empty string if not used." 
    },
    modified_files: {
      type: Type.ARRAY,
      description: "List of files to overwrite with new full contents (used only when action_type is 'auto_commit').",
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
      description: "Details of the code block to post as a suggestion on the PR (used only when action_type is 'suggest_ui').",
      properties: {
        path: { type: Type.STRING, description: "File path to modify." },
        start_line: { type: Type.INTEGER, description: "Start line (1-based) to replace in the original file." },
        end_line: { type: Type.INTEGER, description: "End line (1-based) to replace in the original file." },
        suggested_code: { type: Type.STRING, description: "Replacement code block that will replace the original lines from start_line to end_line." }
      },
      required: ["path", "start_line", "end_line", "suggested_code"]
    },
    findings: {
      type: Type.ARRAY,
      description: "Optional array of findings for the reviewer summary. Each item: {path,start_line,end_line,title,severity,description}",
      items: {
        type: Type.OBJECT,
        properties: {
          path: { type: Type.STRING },
          start_line: { type: Type.INTEGER },
          end_line: { type: Type.INTEGER },
          title: { type: Type.STRING },
          severity: { type: Type.STRING, description: "low|medium|high" },
          description: { type: Type.STRING }
        }
      }
    },
    requires_confirmation: {
      type: Type.ARRAY,
      description: "Optional list of items that need human confirmation. Each item: {id,summary,why,suggested_action}",
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          summary: { type: Type.STRING },
          why: { type: Type.STRING },
          suggested_action: { type: Type.STRING }
        }
      }
    }
  },
  required: [
    "action_type", 
    "comment", 
    "commit_message", 
    "modified_files", 
    "suggestion_details", 
    "findings", 
    "requires_confirmation"
  ]
};

async function run() {
  const prNumber = process.env.PR_NUMBER;
  const rawComment = process.env.USER_COMMENT || '';
  // Workflow trigger uses '@tangpt'
  const userInstructions = rawComment.replace('@tangpt', '').trim();
  const repo = process.env.GITHUB_REPOSITORY;

  console.log("🚀 [DevOps Lead] Reading current PR git diff...");
  // Determine base branch dynamically via gh (safer than hardcoding 'main')
  let prDiff = '';
  let baseRef = 'main';
  try {
    const detected = execSync(`gh pr view ${prNumber} --json baseRefName --jq .baseRefName`).toString().trim();
    if (detected) baseRef = detected;
  } catch (e) {
    console.log('Could not detect baseRef from gh pr view, defaulting to "main"', e.message || e);
  }

  try {
    // ensure we have the base ref locally
    execSync(`git fetch origin ${baseRef}`, { stdio: 'ignore' });
  } catch (e) {
    console.log(`Could not fetch origin/${baseRef}:`, e.message || e);
  }

  try {
    prDiff = execSync(`git diff origin/${baseRef}...HEAD`).toString();
  } catch (e) {
    console.log('git diff failed or no diff available:', e.message || e);
    prDiff = '';
  }

  console.log("🔍 [DevOps Lead] Loading full source context from GitHub cache file...");
  let sourceContext = "Source context not found.";
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

  console.log("🧠 [DevOps Lead] Sending data (cache-optimized) to Gemini 2.5 Flash...");

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    // Strict system instructions + few-shot examples to force JSON-only, schema-compliant output
    contents: [
      // Start the conversation as a user message (the SDK expects lowercase roles and a user-first alternation)
      {
        role: 'user',
        parts: [
          { text: "You are a strict automated code reviewer assistant for engineering PRs. ALWAYS return a single JSON object and NOTHING else. The JSON MUST follow the schema exactly: { action_type, comment, commit_message, modified_files, suggestion_details }. Do not include any prose outside the JSON. If you cannot decide, set action_type to 'suggest_ui' and provide a clear explanation in 'comment'." },
          { text: "Rules: 1) Do not write explanatory text outside JSON. 2) Do not add markdown headers. 3) For 'auto_commit' include full file contents in modified_files. 4) For 'suggest_ui' include suggestion_details with accurate path, start_line, end_line and suggested_code. 5) Use Conventional Commits for commit_message when auto-committing." }
        ]
      },
      // Provide a model example (alternate roles: user -> model -> user)
      {
        role: 'model',
        parts: [
          { text: "EXAMPLE 1 (auto_commit):\n{\n  \"action_type\": \"auto_commit\",\n  \"comment\": \"Fixed a small typo in README.\",\n  \"commit_message\": \"fix(docs): correct README typo\",\n  \"modified_files\": [{\n    \"filepath\": \"README.md\",\n    \"content\": \"# Project\\nUpdated content...\"\n  }],\n  \"suggestion_details\": {}\n}" }
        ]
      },
      // User-level followup: a second example plus the actual context and request. This keeps the conversation alternating and ends on a user message so the model will generate the response.
      {
        role: 'user',
        parts: [
          { text: "EXAMPLE 2 (suggest_ui):\n{\n  \"action_type\": \"suggest_ui\",\n  \"comment\": \"This change touches multiple layers; propose a small refactor to separate concerns.\",\n  \"commit_message\": \"\",\n  \"modified_files\": [],\n  \"suggestion_details\": {\n    \"path\": \"src/foo/bar.js\",\n    \"start_line\": 120,\n    \"end_line\": 140,\n    \"suggested_code\": \"// suggested replacement code...\"\n  }\n}" },
          { text: `Context: Full source context (masked) follows.\n\n${sourceContext}` },
          { text: `User request: ${userInstructions || 'Review the PR and propose fixes.'}` },
          { text: `Git diff: \n${prDiff || 'No diff available'}` }
        ]
      }
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: ResponseSchema,
      temperature: 0.0,
      maxOutputTokens: 2048
    }
  });

  let result = null;
  let sanitizedRaw = '';
  try {
    // Some GenAI SDKs return an object shape; defensive: check .text or .candidates
    let raw = '';
    if (!response) throw new Error('Empty response from model');
    if (typeof response === 'string') raw = response;
    else if (response.text) raw = response.text;
    else if (response.output && response.output[0] && response.output[0].content) raw = response.output[0].content;
    else if (response.candidates && response.candidates[0] && response.candidates[0].content) raw = response.candidates[0].content;
    else raw = JSON.stringify(response);

    // Persist raw response for debugging (sanitized before posting to PR)
    try {
      fs.writeFileSync('ai_raw_response.txt', raw, 'utf8');
    } catch (e) { /* ignore write errors */ }

    // Basic sanitization: redact private keys, obvious secret lines, and long hex-like tokens
    try {
      function sanitizeRawResponse(s) {
        if (!s) return '';
        let out = s.replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
        out = out.replace(/\b(password|secret|token|api[_-]?key|private[_-]?key)\b[^\n]*/ig, '[REDACTED_SENSITIVE_LINE]');
        // redact long alpha-numeric sequences that look like keys
        out = out.replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED_KEY]');
        // truncate for PR comment
        if (out.length > 4000) out = out.slice(0, 4000) + '\n\n...[truncated]';
        return out;
      }
      sanitizedRaw = sanitizeRawResponse(raw);
      try { fs.writeFileSync('ai_raw_response_sanitized.txt', sanitizedRaw, 'utf8'); } catch (e) { /* ignore */ }
    } catch (e) { sanitizedRaw = '[failed to sanitize model response]'; }

    // Try to parse JSON payload if model adhered to schema; otherwise try to heuristically extract JSON block
    try {
      result = JSON.parse(raw);
    } catch (inner) {
      // Try to find first JSON object in the text
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try { result = JSON.parse(m[0]); } catch (e) { result = null; }
      }
    }
  } catch (err) {
    console.error('Failed to parse model response or response is empty:', err);
    // post an informative comment to the PR and exit gracefully (don't throw hard error)
    try {
      const body = `AI returned an invalid or empty result. Please check logs.\n\nSanitized model response (first 4k chars):\n\n${sanitizedRaw || '[no response captured]'}`;
      fs.writeFileSync('ai_error.md', body);
      execSync(`gh pr comment ${prNumber} --body-file=ai_error.md`);
      try { fs.unlinkSync('ai_error.md'); } catch (e) { /* ignore */ }
    } catch (e) {
      console.error('Failed to post error comment to PR:', e);
    }
    // exit with non-zero so workflow marks failure, but do not crash the runner
    process.exit(1);
  }
  // If result is falsy (parsing heuristics failed), post an error and exit to avoid runtime crashes
  if (!result) {
    console.error('Parsed model result is null or invalid after heuristics. Aborting.');
    try {
      const body = `AI returned invalid JSON (could not parse response).\n\nSanitized model response (first 4k chars):\n\n${sanitizedRaw || '[no response captured]'}`;
      fs.writeFileSync('ai_error.md', body);
      execSync(`gh pr comment ${prNumber} --body-file=ai_error.md`);
      try { fs.unlinkSync('ai_error.md'); } catch (e) { /* ignore */ }
    } catch (e) {
      console.error('Failed to post parsing error comment to PR:', e.message || e);
    }
    process.exit(1);
  }

  // Persist parsed result to disk so downstream steps (summary writer) can include structured fields
  try {
    fs.writeFileSync('ai_result.json', JSON.stringify(result, null, 2));
  } catch (e) {
    console.log('Failed to write ai_result.json:', e.message || e);
  }
  // result.comment will be written to files and posted via gh commands directly when needed

  // ================= PROCESS AI RESULT =================

  // Normalize comment: make it terse, actionable, remove polite greetings and long preamble
  if (result && typeof result.comment === 'string') {
    // Keep only first 600 chars and remove salutations like "hi", "hello", "dear"
    result.comment = result.comment.replace(/^\s*(hi|hello|dear)\b[\s\S]*?:?/i, '').trim();
    if (result.comment.length > 600) result.comment = result.comment.slice(0, 600) + '\n\n[...truncated]';
  }

  // Defensive defaults
  result.action_type = result.action_type || 'suggest_ui';

  if (result.action_type === 'auto_commit') {
  console.log("=> [DevOps Lead] Result: AUTO-COMMIT.");
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
      // Write commit_msg.txt but do NOT delete it here; allow the workflow's commit step to handle pushing and cleanup
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
    // Do not remove commit_msg.txt here. The commit step in the workflow will decide whether to commit and then remove it.

  } else if (result.action_type === 'suggest_ui') {
    console.log("=> [DevOps Lead] Result: POST SUGGESTION TO UI.");
    const sug = result.suggestion_details;
  // Build a terse suggestion body: include the minimal short comment, structured findings, confirmation checklist, and the suggestion block
  const shortComment = (result.comment || '').split('\n').slice(0,3).join(' ').trim();

  // Helper: render findings array into a Markdown table
  function renderFindingsMarkdown(findings) {
    if (!Array.isArray(findings) || findings.length === 0) return '';
    let md = '\n\n### Findings\n\n| Severity | Path | Summary | Recommendation |\n|---|---|---|---|\n';
    findings.forEach(f => {
      const sev = (f.severity || f.level || 'info').toString().replace(/\|/g, ' ');
      const p = (f.path || f.area || '').toString().replace(/\|/g, ' ');
      const sum = (f.title || f.summary || '').toString().replace(/\|/g, ' ');
      const rec = (f.recommendation || f.description || '').toString().replace(/\|/g, ' ');
      md += `| ${sev} | ${p} | ${sum} | ${rec} |\n`;
    });
    return md;
  }

  // Helper: render confirmation checklist into Markdown
  function renderConfirmationChecklist(items) {
    if (!Array.isArray(items) || items.length === 0) return '';
    let md = '\n\n### Items needing confirmation\n\n';
    items.forEach(it => {
      const text = (it.summary || it.text || it.description || it.suggested_action || '').toString().trim();
      md += `- [ ] ${text}\n`;
    });
    return md;
  }

  const findingsMd = renderFindingsMarkdown(result.findings);
  const confirmMd = renderConfirmationChecklist(result.requires_confirmation);

  const suggestionBlock = `\n\n\`\`\`suggestion\n${sug.suggested_code}\n\`\`\``;
  const markdownSuggestion = `${shortComment}${suggestionBlock}`;
  const fullCommentBody = `${shortComment}${findingsMd}${confirmMd}${suggestionBlock}`;

    try {
      // Basic validation
      const normalized = path.normalize(sug.path || '');
      if (!sug.path || normalized.startsWith('..')) throw new Error('Invalid suggestion path');
      fs.writeFileSync('comment.md', markdownSuggestion);
      // Try to post an inline PR comment; position may fail if calculated incorrectly, fallback to PR-level comment
      try {
        // Attempt to compute correct diff position so the suggestion becomes "Apply suggestion"-able
        let mappedPosition = null;
        try {
          const prFiles = fetchPrFiles(prNumber);
          const fileObj = prFiles.find(f => f.filename === sug.path || f.filename === sug.path.replace(/^\//, ''));
          if (fileObj && fileObj.patch) {
            // prefer mapping to start_line if available else end_line
            const targetLine = Number(sug.end_line) || Number(sug.start_line) || 1;
            mappedPosition = mapLineToDiffPosition(fileObj.patch, targetLine);
          }
        } catch (e) {
          console.log('Position mapping failed:', e.message || e);
        }

        const usePosition = mappedPosition || (Number(sug.end_line) || 1);
        if (!mappedPosition) {
          console.log('Warning: could not map file line to diff position reliably; using fallback position. Suggestion may not be apply-able via UI.');
        }

        // Create review payload using computed position; include findings and confirmation checklist
        const reviewPayload = {
          body: shortComment || 'AI suggested change',
          event: 'COMMENT',
          comments: [
            {
              path: sug.path,
              position: usePosition,
              body: fullCommentBody
            }
          ]
        };
        fs.writeFileSync('review.json', JSON.stringify(reviewPayload));
        // Use curl with GH_TOKEN to POST raw JSON to the Reviews API
        try {
          const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
          if (!ghToken) throw new Error('GH_TOKEN is not set for posting PR review');
          const apiUrl = `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`;
          execSync(`curl -s -X POST -H "Authorization: token ${ghToken}" -H "Accept: application/vnd.github+json" -H "Content-Type: application/json" -d @review.json ${apiUrl}`);
        } finally {
          try { fs.unlinkSync('review.json'); } catch (e) { /* ignore */ }
          try { fs.unlinkSync('comment.md'); } catch (e) { /* ignore */ }
        }
      } catch (inlineErr) {
        console.log('Creating PR review with suggestion failed, fallback to inline/PR comment:', inlineErr.message || inlineErr);
        try { execSync(`gh api -X POST /repos/${repo}/pulls/${prNumber}/comments -F body=@comment.md -F path=${sug.path} -F position=${sug.end_line}`); } catch (e) { /* ignore */ }
        try { fs.unlinkSync('comment.md'); } catch (e) { /* ignore */ }
      }
    } catch (apiError) {
      console.log('Failed to create suggestion, fallback to PR comment', apiError.message || apiError);
      fs.writeFileSync('comment.md', markdownSuggestion);
      try { execSync(`gh pr comment ${prNumber} --body-file=comment.md`); } catch (e) { /* best-effort */ }
    }
  }
}

// Helper: fetch PR files (with patch) via gh api and return JSON array
function fetchPrFiles(prNumber) {
  try {
    const raw = execSync(`gh api -H "Accept: application/vnd.github+json" /repos/${process.env.GITHUB_REPOSITORY}/pulls/${prNumber}/files`).toString();
    return JSON.parse(raw);
  } catch (e) {
    console.log('Failed to fetch PR files:', e.message || e);
    return [];
  }
}

// Helper: map a source file line number to a diff position value needed by GitHub Reviews API
// We parse the 'patch' field and compute the position of the changed hunk lines. Returns first matching position or null.
function mapLineToDiffPosition(filePatch, targetLine) {
  if (!filePatch) return null;
  // filePatch is a unified diff; positions are counted as lines in the patch starting from 1
  const lines = filePatch.split('\n');
  let position = 0;
  // track current source file line number (the file before the patch) and target file line number
  let curOld = 0;
  let curNew = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    position += 1; // patch line position (1-based)
    const hunkMatch = line.match(/^@@ \-(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      // reset trackers to start of hunk
      curOld = parseInt(hunkMatch[1], 10);
      curNew = parseInt(hunkMatch[3], 10);
      continue; // the @@ line itself is counted in position, continue
    }
    if (line.startsWith('+')) {
      // added line in new file
      if (curNew === targetLine) {
        return position;
      }
      curNew += 1;
    } else if (line.startsWith('-')) {
      // removed line from old file
      curOld += 1;
    } else {
      // context line
      if (curNew === targetLine) {
        return position;
      }
      curOld += 1;
      curNew += 1;
    }
  }
  return null;
}

run().catch(err => {
  console.error("❌ Gemini DevOps Lead bot crashed:", err);
  process.exit(1);
});
