/**
 * C.5g.4 hypothetical device/session lifecycle contracts.
 * All transitions are in-memory proposals over synthetic snapshots. No native
 * authentication, device communication, persistence, or executable grant exists.
 */
import {
    validateDeviceContract,
    validateIdentityDirectory,
    validateInstallationContract,
    validatePrincipalContract,
    validateSessionContract,
} from './identity-contracts.js';
import { evaluateAuthorizationPolicy } from './authorization-engine.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PRINCIPAL_ID = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACCOUNT_STATES = Object.freeze(['pending', 'active', 'suspended', 'revoked']);
const DEVICE_STATES = Object.freeze(['pending', 'active', 'suspended', 'revoked']);
const SESSION_STATES = Object.freeze(['active', 'suspended', 'revoked', 'expired']);
const CLIENT_TYPES = Object.freeze(['windows_desktop', 'ios_mobile', 'smartwatch', 'other']);
const EVIDENCE_METHODS = Object.freeze(['none', 'passkey', 'windows_hello', 'platform_authenticator',
    'device_attestation', 'voice_match']);

function exactRecord(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}

function denseArray(value) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
        || Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return false;
    }
    return true;
}

function canonicalId(value, pattern = UUID) {
    return typeof value === 'string' && value === value.toLowerCase() && pattern.test(value);
}
function timestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }

function validAccount(value) {
    return exactRecord(value, ['accountId', 'principalId', 'status', 'epoch'])
        && canonicalId(value.accountId) && canonicalId(value.principalId, PRINCIPAL_ID)
        && ACCOUNT_STATES.includes(value.status) && integer(value.epoch);
}

function validEvidence(value) {
    return exactRecord(value, ['method', 'observedAt', 'verificationStatus', 'source'])
        && EVIDENCE_METHODS.includes(value.method) && timestamp(value.observedAt)
        && value.verificationStatus === 'unverified' && value.source === 'synthetic_fixture';
}

function deviceProjection(value) {
    return { deviceId: value.deviceId, installationId: value.installationId, principalId: value.principalId,
        status: value.status, createdAt: value.createdAt, revokedAt: value.revokedAt };
}

function validDevice(value) {
    return exactRecord(value, ['deviceId', 'installationId', 'accountId', 'principalId', 'clientType', 'displayName',
        'status', 'trustLevel', 'createdAt', 'linkedAt', 'revokedAt', 'revision'])
        && canonicalId(value.deviceId) && canonicalId(value.installationId) && canonicalId(value.accountId)
        && canonicalId(value.principalId, PRINCIPAL_ID) && CLIENT_TYPES.includes(value.clientType)
        && typeof value.displayName === 'string' && value.displayName.isWellFormed()
        && [...value.displayName].length <= 80 && DEVICE_STATES.includes(value.status)
        && value.trustLevel === 'unverified' && timestamp(value.createdAt)
        && (value.linkedAt === null || timestamp(value.linkedAt))
        && (value.revokedAt === null || timestamp(value.revokedAt)) && integer(value.revision) && value.revision > 0
        && ((value.status === 'pending') === (value.linkedAt === null))
        && ((value.status === 'revoked') === (value.revokedAt !== null))
        && validateDeviceContract(deviceProjection(value));
}

function sessionProjection(value) {
    return { sessionId: value.sessionId, installationId: value.installationId, principalId: value.principalId,
        accountEpoch: value.accountEpoch, deviceId: value.deviceId, authenticationMethod: null,
        assuranceLevel: 'none', expiresAt: value.expiresAt, revokedAt: value.revokedAt };
}

function validSession(value) {
    return exactRecord(value, ['sessionId', 'installationId', 'accountId', 'principalId', 'deviceId', 'status',
        'createdAt', 'expiresAt', 'revokedAt', 'accountEpoch', 'installationEpoch', 'deviceRevision', 'revision',
        'supersedesSessionId', 'authenticationEvidence'])
        && canonicalId(value.sessionId) && canonicalId(value.installationId) && canonicalId(value.accountId)
        && canonicalId(value.principalId, PRINCIPAL_ID)
        && (value.deviceId === null || canonicalId(value.deviceId)) && SESSION_STATES.includes(value.status)
        && timestamp(value.createdAt) && timestamp(value.expiresAt)
        && (value.revokedAt === null || timestamp(value.revokedAt))
        && integer(value.accountEpoch) && integer(value.installationEpoch)
        && (value.deviceRevision === null || (integer(value.deviceRevision) && value.deviceRevision > 0))
        && integer(value.revision) && value.revision > 0
        && (value.supersedesSessionId === null || canonicalId(value.supersedesSessionId))
        && validEvidence(value.authenticationEvidence)
        && ((value.deviceId === null) === (value.deviceRevision === null))
        && ((value.status === 'revoked') === (value.revokedAt !== null))
        && validateSessionContract(sessionProjection(value));
}

function validLinkRequest(value) {
    return exactRecord(value, ['requestId', 'installationId', 'accountId', 'principalId', 'deviceId', 'status',
        'requestedAt', 'expiresAt', 'approvedByPrincipalId', 'approvedAt', 'revision'])
        && canonicalId(value.requestId) && canonicalId(value.installationId) && canonicalId(value.accountId)
        && canonicalId(value.principalId, PRINCIPAL_ID) && canonicalId(value.deviceId)
        && ['pending', 'approved', 'expired'].includes(value.status)
        && timestamp(value.requestedAt) && timestamp(value.expiresAt)
        && (value.approvedByPrincipalId === null || canonicalId(value.approvedByPrincipalId, PRINCIPAL_ID))
        && (value.approvedAt === null || timestamp(value.approvedAt))
        && integer(value.revision) && value.revision > 0
        && (value.status === 'approved'
            ? value.approvedByPrincipalId !== null && value.approvedAt !== null
            : value.approvedByPrincipalId === null && value.approvedAt === null);
}

function validateSnapshot(snapshot) {
    if (!exactRecord(snapshot, ['schemaVersion', 'installation', 'installationEpoch', 'revision', 'evaluatedAt',
        'accounts', 'principals', 'devices', 'sessions', 'linkRequests'])
        || snapshot.schemaVersion !== 1 || !validateInstallationContract(snapshot.installation).valid
        || snapshot.installation.bootstrapState !== 'active' || !integer(snapshot.installationEpoch)
        || snapshot.installationEpoch < 1 || !integer(snapshot.revision) || !timestamp(snapshot.evaluatedAt)
        || !denseArray(snapshot.accounts) || !snapshot.accounts.every(validAccount)
        || !denseArray(snapshot.principals) || !snapshot.principals.every(item => validatePrincipalContract(item).valid)
        || !validateIdentityDirectory(snapshot.installation, snapshot.principals).valid
        || !denseArray(snapshot.devices) || !snapshot.devices.every(validDevice)
        || !denseArray(snapshot.sessions) || !snapshot.sessions.every(validSession)
        || !denseArray(snapshot.linkRequests) || !snapshot.linkRequests.every(validLinkRequest)) return false;

    const principals = new Map(snapshot.principals.map(item => [item.principalId, item]));
    const accountsByPrincipal = new Map();
    const accountIds = new Set();
    for (const account of snapshot.accounts) {
        const principal = principals.get(account.principalId);
        if (!principal || accountIds.has(account.accountId) || accountsByPrincipal.has(account.principalId)
            || account.status !== principal.accountStatus || account.epoch !== principal.accountEpoch) return false;
        accountIds.add(account.accountId);
        accountsByPrincipal.set(account.principalId, account);
    }
    if (accountsByPrincipal.size !== snapshot.principals.length) return false;

    const devices = new Map();
    for (const device of snapshot.devices) {
        const account = accountsByPrincipal.get(device.principalId);
        if (!account || device.installationId !== snapshot.installation.installationId
            || device.accountId !== account.accountId || device.revision > snapshot.revision || devices.has(device.deviceId)
            || (device.status === 'active' && account.status !== 'active')
            || Date.parse(device.createdAt) > Date.parse(snapshot.evaluatedAt)
            || (device.linkedAt !== null && (Date.parse(device.linkedAt) < Date.parse(device.createdAt)
                || Date.parse(device.linkedAt) > Date.parse(snapshot.evaluatedAt)))
            || (device.revokedAt !== null && (Date.parse(device.revokedAt) < Date.parse(device.createdAt)
                || Date.parse(device.revokedAt) > Date.parse(snapshot.evaluatedAt)))
            || (device.status === 'active' && (device.linkedAt === null || device.revokedAt !== null))) return false;
        devices.set(device.deviceId, device);
    }

    const sessions = new Map();
    for (const session of snapshot.sessions) {
        const account = accountsByPrincipal.get(session.principalId);
        const device = session.deviceId === null ? null : devices.get(session.deviceId);
        if (!account || session.installationId !== snapshot.installation.installationId
            || session.accountId !== account.accountId || session.accountEpoch !== account.epoch
            || session.installationEpoch !== snapshot.installationEpoch || sessions.has(session.sessionId)
            || session.revision > snapshot.revision || Date.parse(session.createdAt) > Date.parse(snapshot.evaluatedAt)
            || Date.parse(session.createdAt) >= Date.parse(session.expiresAt)
            || Date.parse(session.authenticationEvidence.observedAt) > Date.parse(session.createdAt)
            || Date.parse(session.authenticationEvidence.observedAt) > Date.parse(snapshot.evaluatedAt)
            || (session.revokedAt !== null && (Date.parse(session.revokedAt) < Date.parse(session.createdAt)
                || Date.parse(session.revokedAt) > Date.parse(snapshot.evaluatedAt)))
            || (session.deviceId !== null && (!device || device.installationId !== session.installationId
                || device.accountId !== session.accountId || device.principalId !== session.principalId
                || session.deviceRevision > device.revision
                || (session.status === 'active' && session.deviceRevision !== device.revision)))
            || (session.deviceId === null && session.deviceRevision !== null)
            || (['active', 'suspended'].includes(session.status) && (account.status !== 'active'
                || Date.parse(session.expiresAt) <= Date.parse(snapshot.evaluatedAt)
                || (session.status === 'active' && device && device.status !== 'active')))
            || (session.status === 'expired' && Date.parse(session.expiresAt) > Date.parse(snapshot.evaluatedAt))) return false;
        sessions.set(session.sessionId, session);
    }
    const superseded = new Set();
    for (const session of snapshot.sessions) {
        if (session.supersedesSessionId !== null) {
            const prior = sessions.get(session.supersedesSessionId);
            if (!prior || prior.sessionId === session.sessionId || superseded.has(prior.sessionId) || prior.status !== 'revoked'
                || prior.principalId !== session.principalId || prior.accountId !== session.accountId
                || prior.installationId !== session.installationId || prior.deviceId !== session.deviceId
                || Date.parse(prior.revokedAt) > Date.parse(session.createdAt)) return false;
            superseded.add(prior.sessionId);
        }
    }

    const requestIds = new Set();
    const pendingDevices = new Set();
    for (const request of snapshot.linkRequests) {
        const account = accountsByPrincipal.get(request.principalId);
        const device = devices.get(request.deviceId);
        const approver = request.approvedByPrincipalId && principals.get(request.approvedByPrincipalId);
        if (!account || !device || requestIds.has(request.requestId) || pendingDevices.has(request.deviceId)
            || request.installationId !== snapshot.installation.installationId || request.accountId !== account.accountId
            || request.principalId !== device.principalId || request.accountId !== device.accountId
            || request.installationId !== device.installationId || request.revision > snapshot.revision
            || Date.parse(request.requestedAt) > Date.parse(snapshot.evaluatedAt)
            || Date.parse(request.expiresAt) <= Date.parse(request.requestedAt)
            || (request.status === 'pending' && (device.status !== 'pending'
                || Date.parse(request.expiresAt) <= Date.parse(snapshot.evaluatedAt)))
            || (request.status === 'approved' && (device.status === 'pending'
                || approver?.role !== 'owner' || approver.accountStatus !== 'active'
                || request.approvedByPrincipalId !== snapshot.installation.ownerPrincipalId
                || Date.parse(request.approvedAt) < Date.parse(request.requestedAt)
                || Date.parse(request.approvedAt) >= Date.parse(request.expiresAt)
                || Date.parse(request.approvedAt) > Date.parse(snapshot.evaluatedAt)))
            || (request.status === 'expired' && (device.status !== 'revoked'
                || Date.parse(request.expiresAt) > Date.parse(snapshot.evaluatedAt)))) return false;
        requestIds.add(request.requestId);
        if (request.status === 'pending') pendingDevices.add(request.deviceId);
    }
    for (const device of snapshot.devices) {
        if (device.status === 'pending' && !pendingDevices.has(device.deviceId)) return false;
    }
    return true;
}

export function validateDeviceSessionSnapshot(snapshot) {
    try {
        const valid = validateSnapshot(snapshot);
        return Object.freeze({ valid, code: valid ? 'valid_contract' : 'device_session_snapshot_invalid' });
    }
    catch { return Object.freeze({ valid: false, code: 'device_session_snapshot_invalid' }); }
}

function frozenClone(value) {
    if (Array.isArray(value)) return Object.freeze(value.map(frozenClone));
    if (value && typeof value === 'object') {
        const copy = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, frozenClone(item)]));
        return Object.freeze(copy);
    }
    return value;
}

function deny(code, mode = 'hypothetical') {
    return Object.freeze({ decision: 'DENY', mode, executable: false, reasonCode: code, nextSnapshot: null });
}

function hypothetical(snapshot, code) {
    if (!validateSnapshot(snapshot)) return deny('transition_result_invalid');
    return Object.freeze({ decision: 'ALLOW', mode: 'hypothetical', executable: false,
        reasonCode: code, nextSnapshot: frozenClone(snapshot) });
}

function accountFor(snapshot, principalId) { return snapshot.accounts.find(item => item.principalId === principalId); }
function principalFor(snapshot, principalId) { return snapshot.principals.find(item => item.principalId === principalId); }

function validAdminAuthorization(authorizationInput, snapshot, actorPrincipalId, resource, at) {
    if (!authorizationInput || authorizationInput.mode !== 'hypothetical'
        || authorizationInput.principalId !== actorPrincipalId
        || authorizationInput.installation?.installationId !== snapshot.installation.installationId
        || JSON.stringify(authorizationInput.installation) !== JSON.stringify(snapshot.installation)
        || authorizationInput.expectedRevision !== snapshot.revision || authorizationInput.currentRevision !== snapshot.revision
        || Date.parse(authorizationInput.evaluatedAt) !== Date.parse(at)
        || authorizationInput.risk !== 'critical'
        || authorizationInput.request?.action !== 'administer'
        || authorizationInput.request?.resource !== resource
        || authorizationInput.request?.scope !== 'installation'
        || authorizationInput.request?.independentConfirmation !== true
        || authorizationInput.request?.requirements?.length !== 1
        || authorizationInput.request.requirements[0]?.permission !== 'admin.devices'
        || authorizationInput.request.requirements[0]?.action !== 'administer'
        || authorizationInput.request.requirements[0]?.resource !== resource
        || authorizationInput.request.requirements[0]?.scope !== 'installation') return false;
    const decision = evaluateAuthorizationPolicy(authorizationInput);
    return decision.decision === 'ALLOW' && decision.mode === 'hypothetical' && decision.executable === false;
}

/** Evaluate a session against its structural account/device bindings. Never authenticates it. */
export function evaluateHypotheticalSession(input) {
    try {
        if (Object.getOwnPropertyDescriptor(input ?? {}, 'mode')?.value === 'execution') return deny('trusted_authentication_unavailable', 'execution');
        if (!exactRecord(input, ['mode', 'snapshot', 'sessionId', 'principalId', 'installationId', 'evaluatedAt'])
            || input.mode !== 'hypothetical' || !validateSnapshot(input.snapshot)
            || !canonicalId(input.sessionId) || !canonicalId(input.principalId, PRINCIPAL_ID)
            || input.installationId !== input.snapshot.installation.installationId
            || !timestamp(input.evaluatedAt) || Date.parse(input.evaluatedAt) !== Date.parse(input.snapshot.evaluatedAt))
            return deny('session_evaluation_input_invalid');
        const session = input.snapshot.sessions.find(item => item.sessionId === input.sessionId);
        const account = accountFor(input.snapshot, input.principalId);
        const principal = principalFor(input.snapshot, input.principalId);
        if (!session || !account || !principal || session.principalId !== input.principalId
            || session.installationId !== input.installationId || session.accountId !== account.accountId
            || session.accountEpoch !== account.epoch || account.status !== 'active'
            || principal.accountStatus !== 'active' || session.status !== 'active'
            || Date.parse(session.expiresAt) <= Date.parse(input.evaluatedAt)) return deny('session_inactive_or_stale');
        return Object.freeze({ decision: 'ALLOW', mode: 'hypothetical', executable: false,
            reasonCode: 'session_structure_consistent_unverified', nextSnapshot: null });
    } catch { return deny('session_evaluation_input_invalid'); }
}

/** Pure lifecycle proposal reducer. Execution is unconditionally denied. */
export function transitionHypotheticalDeviceSession(input) {
    try {
        const mode = Object.getOwnPropertyDescriptor(input ?? {}, 'mode')?.value;
        if (mode === 'execution') return deny('trusted_authentication_unavailable', 'execution');
        if (!input || mode !== 'hypothetical' || !validateSnapshot(input.snapshot)
            || input.expectedRevision !== input.snapshot.revision || !timestamp(input.at)
            || Date.parse(input.at) < Date.parse(input.snapshot.evaluatedAt)) return deny('lifecycle_input_invalid');
        const snapshot = input.snapshot;
        const at = input.at;
        const next = { ...snapshot, revision: snapshot.revision + 1, evaluatedAt: at,
            devices: [...snapshot.devices], sessions: [...snapshot.sessions], linkRequests: [...snapshot.linkRequests] };

        if (input.action === 'request_device_link') {
            if (!exactRecord(input, ['mode', 'action', 'snapshot', 'expectedRevision', 'at', 'actorPrincipalId',
                'deviceId', 'requestId', 'clientType', 'displayName', 'expiresAt'])) return deny('lifecycle_input_invalid');
            const account = accountFor(snapshot, input.actorPrincipalId);
            const principal = principalFor(snapshot, input.actorPrincipalId);
            if (!account || !principal || account.status !== 'active' || principal.accountStatus !== 'active'
                || !canonicalId(input.deviceId) || !canonicalId(input.requestId) || !CLIENT_TYPES.includes(input.clientType)
                || typeof input.displayName !== 'string' || !input.displayName.isWellFormed()
                || [...input.displayName].length > 80 || !timestamp(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(at)
                || snapshot.devices.some(device => device.deviceId === input.deviceId)
                || snapshot.linkRequests.some(request => request.requestId === input.requestId)) return deny('device_link_request_invalid');
            next.devices.push({ deviceId: input.deviceId, installationId: snapshot.installation.installationId,
                accountId: account.accountId, principalId: principal.principalId, clientType: input.clientType,
                displayName: input.displayName, status: 'pending', trustLevel: 'unverified', createdAt: at,
                linkedAt: null, revokedAt: null, revision: 1 });
            next.linkRequests.push({ requestId: input.requestId, installationId: snapshot.installation.installationId,
                accountId: account.accountId, principalId: principal.principalId, deviceId: input.deviceId,
                status: 'pending', requestedAt: at, expiresAt: input.expiresAt, approvedByPrincipalId: null,
                approvedAt: null, revision: next.revision });
            return hypothetical(next, 'device_link_pending_owner_approval');
        }

        if (input.action === 'expire_sessions') {
            if (!exactRecord(input, ['mode', 'action', 'snapshot', 'expectedRevision', 'at'])) return deny('lifecycle_input_invalid');
            let changed = false;
            next.sessions = next.sessions.map(session => {
                if (['active', 'suspended'].includes(session.status) && Date.parse(session.expiresAt) <= Date.parse(at)) {
                    changed = true; return { ...session, status: 'expired', revision: session.revision + 1 };
                }
                return session;
            });
            if (!changed) return deny('no_expired_sessions');
            return hypothetical(next, 'sessions_expired_hypothetically');
        }

        if (input.action === 'expire_link_request') {
            if (!exactRecord(input, ['mode', 'action', 'snapshot', 'expectedRevision', 'at', 'requestId'])) return deny('lifecycle_input_invalid');
            const requestIndex = next.linkRequests.findIndex(request => request.requestId === input.requestId
                && request.status === 'pending' && Date.parse(request.expiresAt) <= Date.parse(at));
            if (requestIndex < 0) return deny('link_request_not_expired');
            const request = next.linkRequests[requestIndex];
            next.linkRequests[requestIndex] = { ...request, status: 'expired', revision: next.revision };
            const deviceIndex = next.devices.findIndex(device => device.deviceId === request.deviceId);
            next.devices[deviceIndex] = { ...next.devices[deviceIndex], status: 'revoked', revokedAt: at,
                revision: next.devices[deviceIndex].revision + 1 };
            return hypothetical(next, 'device_link_request_expired');
        }

        if (input.action === 'renew_session') {
            if (!exactRecord(input, ['mode', 'action', 'snapshot', 'expectedRevision', 'at', 'principalId',
                'sessionId', 'newSessionId', 'expiresAt', 'authenticationEvidence'])) return deny('lifecycle_input_invalid');
            const currentIndex = next.sessions.findIndex(session => session.sessionId === input.sessionId);
            const current = next.sessions[currentIndex];
            const account = accountFor(snapshot, input.principalId);
            if (!current || !account || current.principalId !== input.principalId || account.status !== 'active'
                || current.status !== 'active' || Date.parse(current.expiresAt) <= Date.parse(at)
                || !canonicalId(input.newSessionId) || next.sessions.some(session => session.sessionId === input.newSessionId)
                || !timestamp(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(at)
                || !validEvidence(input.authenticationEvidence)) return deny('session_renewal_invalid');
            const device = current.deviceId === null ? null : snapshot.devices.find(item => item.deviceId === current.deviceId);
            if (device && (device.status !== 'active' || device.revision !== current.deviceRevision)) return deny('session_device_stale');
            next.sessions[currentIndex] = { ...current, status: 'revoked', revokedAt: at, revision: current.revision + 1 };
            next.sessions.push({ ...current, sessionId: input.newSessionId, status: 'active', createdAt: at,
                expiresAt: input.expiresAt, revokedAt: null, revision: 1, supersedesSessionId: current.sessionId,
                authenticationEvidence: input.authenticationEvidence });
            return hypothetical(next, 'session_renewed_hypothetically');
        }

        const adminActions = ['approve_device_link', 'suspend_device', 'revoke_device', 'unlink_device'];
        if (!adminActions.includes(input.action)
            || !exactRecord(input, ['mode', 'action', 'snapshot', 'expectedRevision', 'at', 'actorPrincipalId',
                ...(input.action === 'approve_device_link' ? ['requestId'] : ['deviceId']), 'authorizationInput']))
            return deny('lifecycle_action_invalid');
        const actor = principalFor(snapshot, input.actorPrincipalId);
        const actorAccount = accountFor(snapshot, input.actorPrincipalId);
        if (!actor || !actorAccount || actor.role !== 'owner' || actor.accountStatus !== 'active'
            || actor.principalId !== snapshot.installation.ownerPrincipalId || actorAccount.status !== 'active')
            return deny('owner_required');

        let deviceIndex;
        let device;
        let permissionAction;
        if (input.action === 'approve_device_link') {
            const requestIndex = next.linkRequests.findIndex(request => request.requestId === input.requestId && request.status === 'pending');
            if (requestIndex < 0) return deny('link_request_unavailable');
            const request = next.linkRequests[requestIndex];
            if (Date.parse(request.expiresAt) <= Date.parse(at)) return deny('link_request_expired');
            deviceIndex = next.devices.findIndex(item => item.deviceId === request.deviceId && item.status === 'pending');
            permissionAction = 'bind';
            if (deviceIndex < 0) return deny('pending_device_missing');
            device = next.devices[deviceIndex];
        } else {
            deviceIndex = next.devices.findIndex(item => item.deviceId === input.deviceId);
            device = next.devices[deviceIndex];
            permissionAction = input.action === 'suspend_device' ? 'suspend' : 'revoke';
            if (!device || !['active', 'suspended'].includes(device.status)
                || (input.action === 'suspend_device' && device.status !== 'active')) return deny('device_not_active');
        }
        const resource = `admin.device.${permissionAction}.device_${device.deviceId}`;
        if (!validAdminAuthorization(input.authorizationInput, snapshot, actor.principalId, resource, at))
            return deny('owner_permission_or_confirmation_missing');

        if (input.action === 'approve_device_link') {
            const requestIndex = next.linkRequests.findIndex(request => request.requestId === input.requestId);
            const request = next.linkRequests[requestIndex];
            next.devices[deviceIndex] = { ...device, status: 'active', linkedAt: at, revision: device.revision + 1 };
            next.linkRequests[requestIndex] = { ...request, status: 'approved', approvedByPrincipalId: actor.principalId,
                approvedAt: at, revision: next.revision };
            return hypothetical(next, 'device_link_approved_hypothetically');
        }

        const revoke = input.action !== 'suspend_device';
        next.devices[deviceIndex] = { ...device, status: revoke ? 'revoked' : 'suspended',
            revokedAt: revoke ? at : null, revision: device.revision + 1 };
        next.sessions = next.sessions.map(session => {
            if (session.deviceId !== device.deviceId || !['active', 'suspended'].includes(session.status)) return session;
            return { ...session, status: revoke ? 'revoked' : 'suspended', revokedAt: revoke ? at : null,
                revision: session.revision + 1 };
        });
        return hypothetical(next, revoke ? 'device_revoked_and_sessions_invalidated' : 'device_suspended_and_sessions_suspended');
    } catch {
        return deny('lifecycle_input_invalid');
    }
}
