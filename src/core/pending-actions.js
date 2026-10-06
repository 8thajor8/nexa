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
    function create({ type, payload, preview, sessionId, replaceTypes = [], replaceIds = [] }) {
        if (typeof sessionId !== 'string' || !sessionId || typeof type !== 'string' || !type) throw new TypeError('pending_action_context_invalid');
        removeExpired();
        for (const [id, action] of actions) {
            if (action.sessionId === sessionId && (replaceTypes.includes(action.type) || replaceIds.includes(id))) actions.delete(id);
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
    function claimApproved({ id, sessionId }) {
        removeExpired();
        const action = actions.get(id);
        if (!action || action.sessionId !== sessionId) return { success: false, error: { code: 'pending_action_invalid', message: 'La acción pendiente no existe, venció o pertenece a otra sesión.' } };
        if (payloadDigest(action.type, action.payload) !== action.digest) {
            actions.delete(id);
            return { success: false, error: { code: 'pending_action_integrity_error', message: 'La acción pendiente cambió y fue invalidada. Preparala nuevamente.' } };
        }
        actions.delete(id);
        return { success: true, type: action.type, payload: structuredClone(action.payload) };
    }
    function list({ sessionId }) {
        removeExpired();
        return [...actions.values()].filter(action => action.sessionId === sessionId).map(action => ({
            id: action.id, type: action.type, preview: action.preview,
            payload: structuredClone(action.payload), createdAt: action.createdAt, expiresAt: action.expiresAt,
            confirmationPhrase: action.confirmationPhrase,
        }));
    }
    function setSelected({ id, sessionId }) {
        removeExpired();
        const action = actions.get(id);
        if (!action || action.sessionId !== sessionId) return false;
        selectedBySession.set(sessionId, id);
        return true;
    }
    function getSelected({ sessionId }) {
        removeExpired();
        const id = selectedBySession.get(sessionId);
        const action = id ? actions.get(id) : null;
        if (!action || action.sessionId !== sessionId) { selectedBySession.delete(sessionId); return null; }
        return { id: action.id, type: action.type, preview: action.preview, payload: structuredClone(action.payload) };
    }
    function clearSelected({ sessionId }) { selectedBySession.delete(sessionId); }
    function cancel({ id, sessionId }) {
        removeExpired();
        const action = actions.get(id);
        if (!action || action.sessionId !== sessionId) return { success: false, error: { code: 'pending_action_invalid', message: 'La acción pendiente no existe, venció o pertenece a otra sesión.' } };
        actions.delete(id);
        if (selectedBySession.get(sessionId) === id) selectedBySession.delete(sessionId);
        return { success: true };
    }
    function cancelAll({ sessionId }) {
        removeExpired();
        let count = 0;
        for (const [id, action] of actions) if (action.sessionId === sessionId) { actions.delete(id); count++; }
        selectedBySession.delete(sessionId);
        return { success: true, count };
    }
    function invalidateSession(sessionId, types = []) {
        for (const [id, action] of actions) {
            if (action.sessionId === sessionId && (!types.length || types.includes(action.type))) actions.delete(id);
        }
        selectedBySession.delete(sessionId);
    }
    const selectedBySession = new Map();
    return { create, claim, claimApproved, list, setSelected, getSelected, clearSelected, cancel, cancelAll, invalidateSession };
}
