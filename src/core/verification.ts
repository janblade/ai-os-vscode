import { object } from '../contracts';
export type VerificationEvidence = string | { command: string; result: string | boolean | number; limitations?: string };
export interface VerificationReport { status: 'passed' | 'failed' | 'blocked'; summary: string; verification: VerificationEvidence[] }
export function parseVerificationReport(output: string): VerificationReport {
  let report; try { report = object(JSON.parse(output)); } catch { throw new Error('This phase must return a structured verification report. No subsequent phase was started.'); }
  if (!['passed', 'failed', 'blocked'].includes(String(report.status)) || typeof report.summary !== 'string' || !report.summary.trim() || !Array.isArray(report.verification) || report.status === 'passed' && !report.verification.length) throw new Error('Invalid verification report. No subsequent phase was started.');
  if (report.status !== 'passed') {
    report.verification = report.verification.map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.command === 'string' && ['string', 'boolean', 'number'].includes(typeof item.result) && (item.limitations === undefined || typeof item.limitations === 'string')) return item;
      return JSON.stringify(item);
    });
    return report as unknown as VerificationReport;
  }
  for (const item of report.verification) {
    if (typeof item === 'string') continue;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid verification evidence. No subsequent phase was started.');
    const entry = object(item);
    if (Object.keys(entry).some(key => !['command', 'result', 'limitations'].includes(key)) || typeof entry.command !== 'string' || !entry.command.trim() || !['string', 'boolean', 'number'].includes(typeof entry.result) || typeof entry.result === 'number' && !Number.isFinite(entry.result) || entry.limitations !== undefined && typeof entry.limitations !== 'string') throw new Error('Invalid verification evidence. No subsequent phase was started.');
  }
  return report as unknown as VerificationReport;
}
