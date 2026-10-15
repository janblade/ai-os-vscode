export interface Handoff { nextStep: string; findings: string; unknowns: string; verification: string }
export function appendHandoff(content: string, handoff: Handoff, timestamp: string): string {
  for (const value of Object.values(handoff)) if (typeof value !== 'string' || value.length > 16000) throw new Error('Handoff fields exceed the size limit.');
  if (!handoff.nextStep.trim() || !handoff.verification.trim()) throw new Error('Record a next step and verification performed or explicitly not performed.');
  return `${content.trimEnd()}\n\n## Dashboard handoff - ${timestamp}\n\n### Next step\n${handoff.nextStep}\n\n### Confirmed findings\n${handoff.findings || '(none recorded)'}\n\n### Unknowns and blockers\n${handoff.unknowns || '(none recorded)'}\n\n### Verification\n${handoff.verification}\n`;
}
