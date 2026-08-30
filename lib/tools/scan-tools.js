"use strict";

function getScanTools() {
  return [
    {
      name: "scan_document",
      description: "Scan a Word document for AI-generated content patterns. Returns findings with severity, category, and suggestions.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the .docx file" },
        },
        required: ["file_path"],
      },
    },
    {
      name: "get_findings",
      description: "Get all findings from the last scan. Returns the full list with IDs, severity, category, title, and status.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "get_finding_detail",
      description: "Get detailed analysis of a specific finding including AI analysis and suggested fixes.",
      parameters: {
        type: "object",
        properties: {
          finding_id: { type: "string", description: "Finding ID like F-0001" },
        },
        required: ["finding_id"],
      },
    },
    {
      name: "get_all_paragraphs",
      description: "Get all paragraphs from the scanned document with their scores, levels, and text content.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "approve_finding",
      description: "Approve a finding for fixing.",
      parameters: {
        type: "object",
        properties: {
          finding_id: { type: "string", description: "Finding ID or 'all'" },
        },
        required: ["finding_id"],
      },
    },
    {
      name: "fix_approved",
      description: "Apply all approved fixes to the document.",
      parameters: { type: "object", properties: {} },
    },
  ];
}

async function executeScanTool(name, args, context) {
  const toolNames = new Set(["scan_document", "get_findings", "get_finding_detail", "get_all_paragraphs", "approve_finding", "fix_approved"]);
  if (!toolNames.has(name)) return null;

  const { scanDisk, buildFindings, summarizeFindings, FindingStatus, transitionFinding, suggestRewrite, analyzeFinding } = context.modules;
  const { fs, path } = context;

  switch (name) {
    case "scan_document": {
      const filePath = args.file_path;
      if (!fs.existsSync(filePath)) return { error: "File not found: " + filePath };
      try {
        const result = await scanDisk(filePath);
        context.scanResult = result;
        context.findings = buildFindings(result);
        context.filePath = filePath;
        return {
          file: path.basename(filePath),
          path: filePath,
          paragraphs: result.totalBody,
          score: result.totalScore,
          aiPercentage: result.aiPercentage.toFixed(0) + "%",
          findings: context.findings.length,
          highSeverity: context.findings.filter((f) => f.severity === "HIGH").length,
          mediumSeverity: context.findings.filter((f) => f.severity === "MEDIUM").length,
          lowSeverity: context.findings.filter((f) => f.severity === "LOW").length,
        };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "get_finding_detail": {
      const finding = context.findings.find((f) => f.id === args.finding_id);
      if (!finding) return { error: "Finding not found" };
      const analysis = analyzeFinding(finding, {
        paragraph: context.scanResult?.paragraphs.find((p) => p.index === finding.paragraphIndex),
      });
      return { ...finding, analysis };
    }

    case "approve_finding": {
      if (args.finding_id === "all") {
        let count = 0;
        for (const f of context.findings) {
          if ((f.status === FindingStatus.NEW || f.status === FindingStatus.REVIEWED) && f.fixable) {
            transitionFinding(f, FindingStatus.APPROVED);
            count++;
          }
        }
        return { approved: count };
      }
      const finding = context.findings.find((f) => f.id === args.finding_id);
      if (!finding) return { error: "Finding not found" };
      transitionFinding(finding, FindingStatus.APPROVED);
      return { approved: finding.id };
    }

    case "fix_approved": {
      if (!context.mcpConnected) return { error: "MCP not connected" };
      if (!context.filePath) return { error: "No document loaded" };

      if (!context.backupPath) {
        context.backupPath = await context.mcp.createBackup(context.filePath);
      }

      const approved = context.findings.filter((f) => f.status === FindingStatus.APPROVED);
      if (approved.length === 0) return { error: "No approved findings to fix" };

      // Group by paragraph to avoid duplicate replacements and repeated diffs
      const groups = new Map();
      for (const f of approved) {
        const key = f.paragraphIndex;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
      }

      let fixed = 0, failed = 0;
      for (const [paraIdx, group] of groups) {
        const para = context.scanResult?.paragraphs.find((p) => p.index === paraIdx);
        const original = para ? para.text : group[0].originalContent;
        if (!original || !original.trim()) {
          for (const f of group) { try { transitionFinding(f, FindingStatus.FAILED, { note: "empty" }); } catch(e){} }
          failed += group.length;
          continue;
        }
        const rewrite = suggestRewrite(original, group);
        if (!rewrite.changed) {
          for (const f of group) { try { transitionFinding(f, FindingStatus.FAILED, { note: "no change" }); } catch(e){} }
          failed += group.length;
          continue;
        }
        try {
          const resultText = await context.mcp.searchAndReplace(context.filePath, original, rewrite.rewritten);
          const success = typeof resultText === "string" && resultText.includes("Replaced");
          if (success) {
            for (const f of group) { try { transitionFinding(f, FindingStatus.FIXED); } catch(e){} }
            fixed += group.length;
            if (para) {
              const rescored = context.modules.scoreParagraph ? context.modules.scoreParagraph(rewrite.rewritten, para.index) : null;
              if (rescored) Object.assign(para, rescored, { index: paraIdx });
              else para.text = rewrite.rewritten;
            }
            for (const f of group) f.originalContent = rewrite.rewritten;
          } else {
            // fallback: phrase-level
            let ok = false;
            const fullMap = {
              "the present study": "this research", "present study": "this research",
              "moreover": "also", "furthermore": "in addition", "consequently": "so",
              "facilitates": "helps", "enhances": "improves", "underpins": "supports",
              "integral": "essential", "pivotal": "key", "according to": "as noted by",
              "in terms of": "regarding", "significantly": "greatly", "importantly": "notably",
              "essentially": "basically", "fundamentally": "at its core",
              "comprehensive": "thorough", "crucial": "important", "it is important": "it matters",
            };
            for (const f of group) {
              if (f.category === "em_dash") {
                try { const r = await context.mcp.searchAndReplace(context.filePath, "\u2014", ", "); if (String(r).includes("Replaced")) ok = true; } catch(e){}
              }
              const m = f.title.match(/^"([^"]+)"/);
              if (m && fullMap[m[1].toLowerCase()]) {
                try { const r = await context.mcp.searchAndReplace(context.filePath, m[1], fullMap[m[1].toLowerCase()]); if (String(r).includes("Replaced")) ok = true; } catch(e){}
              }
            }
            if (ok) {
              for (const f of group) { try { transitionFinding(f, FindingStatus.FIXED); } catch(e){} }
              fixed += group.length;
              if (para) {
                const rescored = context.modules.scoreParagraph ? context.modules.scoreParagraph(rewrite.rewritten, para.index) : null;
                if (rescored) Object.assign(para, rescored, { index: paraIdx });
                else para.text = rewrite.rewritten;
              }
              for (const f of group) f.originalContent = rewrite.rewritten;
            } else {
              for (const f of group) { try { transitionFinding(f, FindingStatus.FAILED, { note: String(resultText).slice(0,80) }); } catch(e){} failed += group.length; }
            }
          }
        } catch (e) {
          for (const f of group) { try { transitionFinding(f, FindingStatus.FAILED, { note: e.message }); } catch(err){} }
          failed += group.length;
        }
      }
      // Recompute scores dynamically so subsequent get_findings / header show correct values not stale repeated ones
      if (context.scanResult && context.scanResult.paragraphs) {
        const totalScore = context.scanResult.paragraphs.reduce((s, p) => s + (p.score || 0), 0);
        const avgScore = context.scanResult.paragraphs.length ? totalScore / context.scanResult.paragraphs.length : 0;
        context.scanResult.totalScore = totalScore;
        context.scanResult.aiPercentage = Math.min(Math.round((avgScore / 30) * 100), 100);
        context.scanResult.highCount = context.scanResult.paragraphs.filter((p) => p.level === "HIGH").length;
        context.scanResult.mediumCount = context.scanResult.paragraphs.filter((p) => p.level === "MEDIUM").length;
        context.scanResult.lowCount = context.scanResult.paragraphs.filter((p) => p.level === "LOW").length;
      }
      return { fixed, failed, backup: context.backupPath, document: context.filePath };
    }

    case "get_findings": {
      if (!context.findings || context.findings.length === 0) {
        return { error: "No findings. Run scan_document first." };
      }
      return {
        total: context.findings.length,
        findings: context.findings.map((f) => ({
          id: f.id,
          severity: f.severity,
          category: f.category,
          title: f.title,
          status: f.status,
          fixable: f.fixable,
          paragraphIndex: f.paragraphIndex,
        })),
      };
    }

    case "get_all_paragraphs": {
      if (!context.scanResult || !context.scanResult.paragraphs) {
        return { error: "No paragraphs. Run scan_document first." };
      }
      return {
        total: context.scanResult.paragraphs.length,
        paragraphs: context.scanResult.paragraphs.map((p) => ({
          index: p.index,
          score: p.score,
          level: p.level,
          wordCount: p.wordCount,
          sentenceCount: p.sentenceCount,
          text: p.text.slice(0, 300),
        })),
      };
    }

    default:
      return null; // not handled
  }
}

module.exports = { getScanTools, executeScanTool };
