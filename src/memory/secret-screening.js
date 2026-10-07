const patterns = Object.freeze([
    ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/iu],
    ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,}/iu],
    ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u],
    ['api_key', /\bsk-[A-Za-z0-9_-]{20,}\b/u],
    ['api_key', /\bAIza[0-9A-Za-z_-]{30,}\b/u],
    ['api_key', /\bAKIA[0-9A-Z]{16}\b/u],
    ['api_key', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u],
    ['api_key', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
    ['credential', /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret[_ -]?key)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/iu],
    ['password', /\b(?:password|passwd|pwd)\s*[:=]\s*["']?[^\s"'`]{12,}/iu],
    ['credential', /\b(?:auth[_ -]?cookie|session[_ -]?cookie)\s*[:=]\s*["']?[^\s"'`]{12,}/iu],
]);

/** Returns a reason code only; never returns the match or surrounding text. */
export function screenMemorySecret(value) {
    if (typeof value !== 'string') return { safe: false, reason: 'memory_value_invalid' };
    for (const [kind, pattern] of patterns) {
        if (pattern.test(value)) return { safe: false, reason: 'memory_secret_suspected', kind };
    }
    return { safe: true, reason: null, kind: null };
}
