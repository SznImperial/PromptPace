export interface LoopAnalysisResult {
  riskScore: number; // 0 to 100
  isLoopDetected: boolean;
  reason?: string;
  duplicateCount: number;
}

export class LoopDetector {
  private recentSignatures: Array<{
    hash: string;
    timestamp: number;
    promptSnippet: string;
  }> = [];

  private maxHistory = 15;

  public analyzeRequest(promptSnippet: string): LoopAnalysisResult {
    const now = Date.now();
    const cleanSnippet = promptSnippet.trim().toLowerCase().slice(0, 300);
    const hash = this.simpleHash(cleanSnippet);

    // Prune entries older than 3 minutes
    this.recentSignatures = this.recentSignatures.filter(
      (entry) => now - entry.timestamp < 180000
    );

    // Check for exact / near duplicate hash in recent history
    let duplicateCount = 0;
    for (const entry of this.recentSignatures) {
      if (entry.hash === hash || this.similarity(entry.promptSnippet, cleanSnippet) > 0.85) {
        duplicateCount++;
      }
    }

    // Check burst rate: how many requests in the last 10 seconds?
    const burstCount = this.recentSignatures.filter(
      (entry) => now - entry.timestamp < 10000
    ).length;

    // Push current entry
    this.recentSignatures.push({
      hash,
      timestamp: now,
      promptSnippet: cleanSnippet,
    });

    if (this.recentSignatures.length > this.maxHistory) {
      this.recentSignatures.shift();
    }

    // Heuristics calculation
    let riskScore = 0;
    let reason = '';

    if (duplicateCount >= 3) {
      riskScore = 90;
      reason = `Repetitive retry pattern detected (${duplicateCount} identical iterations in 3m)`;
    } else if (duplicateCount === 2) {
      riskScore = 65;
      reason = 'Potential retry loop emerging (2 near-identical prompts)';
    }

    if (burstCount >= 5) {
      riskScore = Math.max(riskScore, 85);
      reason = reason ? `${reason} + High burst rate (${burstCount} reqs / 10s)` : `Rapid request burst detected (${burstCount} reqs / 10s)`;
    }

    const isLoopDetected = riskScore >= 75;

    return {
      riskScore,
      isLoopDetected,
      reason: reason || undefined,
      duplicateCount,
    };
  }

  public reset(): void {
    this.recentSignatures = [];
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32bit integer
    }
    return hash.toString(16);
  }

  private similarity(s1: string, s2: string): number {
    if (!s1 || !s2) return 0;
    if (s1 === s2) return 1.0;
    
    // Quick Jaccard similarity of 3-character shingles
    const set1 = this.getShingles(s1);
    const set2 = this.getShingles(s2);
    
    let intersection = 0;
    for (const shingle of set1) {
      if (set2.has(shingle)) intersection++;
    }
    
    const union = set1.size + set2.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  private getShingles(str: string): Set<string> {
    const shingles = new Set<string>();
    for (let i = 0; i < str.length - 3; i++) {
      shingles.add(str.slice(i, i + 3));
    }
    return shingles;
  }
}
