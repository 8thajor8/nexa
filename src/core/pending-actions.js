import { createHash, randomBytes } from 'node:crypto';

const defaultTtlMs = 5 * 60 * 1000;

function payloadDigest(type, payload) {
    return createHash('sha256').update(JSON.stringify({ type, payload })).digest('hex');
}
function matchesConfirmation(userMessage, phrase) {
    return typeof userMessage === 'string' && userMessage === phrase;
}
export function createPendingActionManager({ ttlMs = defaultTtlMs, now = Date.now } = {}) {
    const actions = new Map();

    function removeExpired() {
        const instant = now();
        for (const [id, action] of actions) if (action.expiresAtMs <= instant) actions.delete(id);
    }
    function publicAction(action) {
        return { id: action.id, type: action.type, preview: action.preview,
            createdAt: action.createdAt, expiresAt: action.expiresAt, confirmationPhrase: action.confirmationPhrase };
    }
    function create({ type, payload, preview, sessionId, replaceTypes = [] }) {
        if (typeof sessionId !== 'string' || !sessionId || typeof type !== 'string' || !type) throw new TypeError('pending_action_context_invalid');
        removeExpired();
        for (const [id, action] of actions) {
            if (action.sessionId === sessionId && replaceTypes.includes(action.type)) actions.delete(id);
        }
        const instant = now(), id = 'action_' + randomBytes(16).toString('hex');
        const expiresAtMs = instant + ttlMs;
        const action = {
            id, type, payload: structuredClone(payload), preview, sessionId,
            createdAt: new Date(instant).toISOString(), expiresAtMs,
            expiresAt: new Date(expiresAtMs).toISOString(),
            confirmationPhrase: 'confirmar envío ' + id,
            digest: payloadDigest(type, payload),
        };
        actions.set(id, action);
        return publicAction(action);
    }
    function claim({ id, sessionId, userMessage }) {
        removeExpired();
        const action = actions.get(id);
        if (!action || action.sessionId !== sessionId) return { success: false, error: { code: 'pending_action_invalid', message: 'La acción pendiente no existe, venció o pertenece a otra sesión.' } };
        if (!matchesConfirmation(userMessage, action.confirmationPhrase)) return { success: false, error: { code: 'fresh_confirmation_required', message: 'Para continuar, respondé exactamente con la frase de confirmación que aparece en la vista previa.' } };
        if (payloadDigest(action.type, action.payload) !== action.digest) {
            actions.delete(id);
            return { success: false, error: { code: 'pending_action_integrity_error', message: 'La acción pendiente cambió y fue invalidada. Preparala nuevamente.' } };
        }
        actions.delete(id);
        return { success: true, type: action.type, payload: structuredClone(action.payload) };
    }
    function cancel({ id, sessionId }) {
        removeExpired();
        const action = actions.get(id);
        if (!action || action.sessionId !== sessionId) return { success: false, error: { code: 'pending_action_invalid', message: 'La acción pendiente no existe, venció o pertenece a otra sesión.' } };
        actions.delete(id);
        return { success: true };
    }
    function invalidateSession(sessionId, types = []) {
        for (const [id, action] of actions) {
            if (action.sessionId === sessionId && (!types.length || types.includes(action.type))) actions.delete(id);
        }
    }
    return { create, claim, cancel, invalidateSession };
}
