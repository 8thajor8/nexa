import { createHash } from 'node:crypto';
import { assertExactObject } from './schema.js';
import { consumeDirectUserTurn, isDirectUserTurnCurrent } from '../core/direct-user-input.js';
import { validateRememberProposal, validateForgetTarget, validatePersonCreation } from './commands.js';
export { validateRememberProposal } from './commands.js';

const grants = new WeakMap();
function fail() {
    const error = new Error('An explicit, matching current user memory command is required.');
    error.name = 'MemoryAuthorizationError'; error.code = 'memory_write_not_authorized';
    return error;
}
function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
}
function fingerprint(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }

// No issuer accepting input text is exported. The proof must originate from
// the real terminal reader and is consumed even on a mismatched request.
function authorize(input, operation, field) {
    try {
        assertExactObject(input, ['capability', 'recipient', field], 'authorization');
        const command = consumeDirectUserTurn(input.capability, input.recipient);
        if (operation === 'remember') validateRememberProposal(input[field]);
        else if (operation === 'create_person') validatePersonCreation(input[field]);
        else validateForgetTarget(input[field]);
        if (!command || command.operation !== operation || fingerprint(command.request) !== fingerprint(input[field])) throw fail();
        const grant = Object.freeze(Object.create(null));
        grants.set(grant, { operation, fingerprint: fingerprint(command.request),
            capability: input.capability, recipient: input.recipient });
        return grant;
    } catch { throw fail(); }
}
export function authorizeMemoryRemember(input) { return authorize(input, 'remember', 'proposal'); }
export function authorizePersonCreation(input) { return authorize(input, 'create_person', 'request'); }
export function authorizeMemoryForget(input) { return authorize(input, 'forget', 'target'); }

export function consumeMemoryAuthorization(grant, operation, scope, recipient) {
    const issued = grants.get(grant);
    grants.delete(grant);
    if (!issued || issued.operation !== operation || issued.recipient !== recipient
        || !isDirectUserTurnCurrent(issued.capability, recipient)
        || issued.fingerprint !== fingerprint(scope)) throw fail();
    return true;
}
