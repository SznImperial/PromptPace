export interface LoopAnalysisResult {
  riskScore: number; // 0 to 100
  isLoopDetected: boolean;
  reason?: string;
  duplicateCount: number;
  maxSimilarity: number;
}

export class LoopDetector {
  private recentHistory: Array<{
    rawHash: string;
    normalizedHash: string;
    normalizedText: string;
    timestamp: number;
  }> = [];

  private maxWindow = 8;

  /**
   * Sanitizes prompt and error content by stripping volatile elements:
   * - ANSI color codes
   * - ISO timestamps, Unix epoch timestamps, relative time strings
   * - Volatile file paths (e.g., /tmp/..., C:\Users\..., .next/...)
   * - Random UUIDs, hashes, port numbers, line/column numbers
   */
  public normalizeContent(content: string): string {
    if (!content) return '';

    return content
      // Strip ANSI escape codes
      .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
      // Strip ISO timestamps (e.g., 2026-08-14T22:44:11.123Z)
      .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/gi, '')
      // Strip Unix epoch timestamps (10-13 digits)
      .replace(/\b1[6-9]\d{8,11}\b/g, '')
      // Strip UUIDs (e.g. 123e4567-e89b-12d3-a456-426614174000)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
      // Strip file paths with line/col numbers (e.g., src/auth.ts:42:15 or C:\project\index.js:10)
      .replace(/(?:[a-zA-Z]:\\|\/)?(?:[\w.-]+[/\\])+[\w.-]+(?::\d+(?::\d+)?)?/g, '[PATH]')
      // Strip memory addresses (0x7ffe...)
      .replace(/0x[0-9a-fA-F]+/g, '[HEX]')
      // Normalize variable whitespace
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  public analyzeRequest(promptSnippet: string): LoopAnalysisResult {
    const now = Date.now();
    const rawHash = this.simpleHash(promptSnippet.trim());
    const normalizedText = this.normalizeContent(promptSnippet);
    const normalizedHash = this.simpleHash(normalizedText);

    // Prune entries older than 4 minutes
    this.recentHistory = this.recentHistory.filter(
      (entry) => now - entry.timestamp < 240000
    );

    let exactNormalizedMatches = 0;
    let maxSimilarity = 0.0;
    let nearDuplicateCount = 0;

    for (const prev of this.recentHistory) {
      if (prev.normalizedHash === normalizedHash) {
        exactNormalizedMatches++;
        maxSimilarity = 1.0;
      } else {
        const sim = this.calculateSimilarity(prev.normalizedText, normalizedText);
        if (sim > maxSimilarity) {
          maxSimilarity = sim;
        }
        if (sim >= 0.88) {
          nearDuplicateCount++;
        }
      }
    }

    // Check burst rate: how many requests in the last 10 seconds?
    const burstCount = this.recentHistory.filter(
      (entry) => now - entry.timestamp < 10000
    ).length;

    // Push current entry into rolling window
    this.recentHistory.push({
      rawHash,
      normalizedHash,
      normalizedText,
      timestamp: now,
    });

    if (this.recentHistory.length > this.maxWindow) {
      this.recentHistory.shift();
    }

    // Heuristics Score Calculation
    let riskScore = 0;
    let reason = '';

    if (exactNormalizedMatches >= 2) {
      riskScore = 95;
      reason = `Identical normalized loop detected (${exactNormalizedMatches + 1} identical iterations in rolling window)`;
    } else if (exactNormalizedMatches === 1) {
      riskScore = 70;
      reason = 'Duplicate normalized prompt detected in recent window';
    } else if (nearDuplicateCount >= 2 || maxSimilarity >= 0.90) {
      riskScore = 85;
      reason = `Fuzzy retry death-loop detected (${(maxSimilarity * 100).toFixed(0)}% prompt overlap)`;
    } else if (nearDuplicateCount === 1 || maxSimilarity >= 0.82) {
      riskScore = 55;
      reason = `High prompt similarity detected (${(maxSimilarity * 100).toFixed(0)}% match)`;
    }

    if (burstCount >= 5) {
      riskScore = Math.max(riskScore, 90);
      reason = reason
        ? `${reason} + High burst rate (${burstCount} reqs / 10s)`
        : `Rapid request burst detected (${burstCount} reqs / 10s)`;
    }

    const isLoopDetected = riskScore >= 75;

    return {
      riskScore,
      isLoopDetected,
      reason: reason || undefined,
      duplicateCount: exactNormalizedMatches + nearDuplicateCount,
      maxSimilarity: Number(maxSimilarity.toFixed(2)),
    };
  }

  public reset(): void {
    this.recentHistory = [];
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return hash.toString(16);
  }

  /**
   * Fast hybrid similarity combining 3-gram Jaccard overlap and word token overlap
   */
  private calculateSimilarity(s1: string, s2: string): number {
    if (!s1 || !s2) return 0;
    if (s1 === s2) return 1.0;

    // Word token overlap
    const words1 = new Set(s1.split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(s2.split(/\s+/).filter(w => w.length > 2));
    
    let wordInter = 0;
    for (const w of words1) {
      if (words2.has(w)) wordInter++;
    }
    const wordUnion = words1.size + words2.size - wordInter;
    const wordSim = wordUnion === 0 ? 0 : wordInter / wordUnion;

    // 3-gram character shingles overlap
    const sh1 = this.getShingles(s1);
    const sh2 = this.getShingles(s2);

    let shInter = 0;
    for (const s of sh1) {
      if (sh2.has(s)) shInter++;
    }
    const shUnion = sh1.size + sh2.size - shInter;
    const shSim = shUnion === 0 ? 0 : shInter / shUnion;

    // Weighted combination
    return 0.6 * wordSim + 0.4 * shSim;
  }

  private getShingles(str: string): Set<string> {
    const shingles = new Set<string>();
    for (let i = 0; i < str.length - 3; i++) {
      shingles.add(str.slice(i, i + 3));
    }
    return shingles;
  }
}
