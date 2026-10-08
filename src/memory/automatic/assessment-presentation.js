import { screenMemorySecret } from '../secret-screening.js';

const DISPLAYABLE_DISPOSITIONS = new Set(['auto_save', 'ask']);

function clean(value, maxLength = 180) {
    return typeof value === 'string'
        ? value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, maxLength)
        : '';
}

/** Formats only ephemeral user-facing review output; it has no storage dependency. */
export function formatAutomaticMemoryAssessment(result) {
    if (!result || result.success !== true || result.assessed !== true || !Array.isArray(result.candidates)) return [];
    const displayable = result.candidates.filter(candidate => DISPLAYABLE_DISPOSITIONS.has(candidate?.disposition));
    if (!displayable.length) return [];
    const lines = ['Posibles recuerdos (revisión efímera; no se guardó ningún recuerdo):'];
    for (const candidate of displayable) {
        const category = clean(candidate.proposal?.candidate_type, 40) || 'candidato';
        const proposedValue = candidate.proposal ? clean(candidate.proposal.value_text) : '';
        const safeToDisplay = candidate.proposal?.sensitivity === 'none'
            && screenMemorySecret(proposedValue).safe;
        const value = safeToDisplay && proposedValue ? proposedValue : 'contenido omitido por seguridad';
        const reasons = Array.isArray(candidate.reasonCodes)
            ? candidate.reasonCodes.filter(code => typeof code === 'string' && /^[a-z0-9_]{1,80}$/u.test(code)).slice(0, 8)
            : [];
        lines.push(`- propuesta ${candidate.disposition} · ${category}: ${value}${reasons.length ? ` (${reasons.join(', ')})` : ''}`);
    }
    return lines;
}
