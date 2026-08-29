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

      let fixed = 0, failed = 0;
      for (const f of approved) {
        try {
          const rewrite = suggestRewrite(f.originalContent, [f]);
          if (rewrite.changed) {
            const match = f.title.match(/^"([^"]+)"/);
            const orig = match ? match[1] : f.evidence.slice(0, 50);
            await context.mcp.searchAndReplace(context.filePath, orig, rewrite.rewritten.slice(0, 200));
            transitionFinding(f, FindingStatus.FIXED);
            fixed++;
          } else {
            transitionFinding(f, FindingStatus.FAILED, { note: "no change" });
            failed++;
          }
        } catch (e) {
          transitionFinding(f, FindingStatus.FAILED, { note: e.message });
          failed++;
        }
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
