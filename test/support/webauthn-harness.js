import {
    createHash,
    createPublicKey,
    generateKeyPairSync,
    randomBytes as nodeRandomBytes,
    randomUUID,
    sign,
    verify,
} from 'node:crypto';

// Test-only protocol harness. Keep this file under test/ and never import it
// from src/. Its synthetic signatures are not a WebAuthn verifier or provider.
const authenticators = new WeakMap();
const TERMINAL_OUTCOMES = new Set(['cancelled', 'timed_out', 'denied', 'ambiguous']);
const PURPOSES = new Set(['registration', 'authentication', 'step_up', 'owner_bootstrap']);
const TEST_ID = /^test_[a-z0-9._-]{1,80}$/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const MAX_TTL_MS = 120_000;

function exactRecord(value, keys) {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
        const own = Reflect.ownKeys(value);
        return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
            && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
    } catch { return false; }
}

function optionalRecord(value, allowedKeys) {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
        return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowedKeys.includes(key)
            && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
    } catch { return false; }
}

function frozen(value) { return Object.freeze(value); }
function digest(value) { return createHash('sha256').update(value).digest(); }
function b64url(value) { return Buffer.from(value).toString('base64url'); }
function validB64url(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value)
        && Buffer.from(value, 'base64url').toString('base64url') === value;
}
function fail(code) {
    return frozen({ status: 'rejected', code, executable: false, persistencePerformed: false,
        authorization: 'DENY' });
}
function success(code, fields = {}) {
    return frozen({ status: 'accepted_synthetic', code, ...fields, executable: false,
        persistencePerformed: false, authorization: 'DENY' });
}
function validOrigin(origin) {
    if (typeof origin !== 'string') return false;
    try {
        const parsed = new URL(origin);
        return parsed.protocol === 'https:' && parsed.origin === origin && parsed.pathname === '/'
            && !parsed.search && !parsed.hash;
    } catch { return false; }
}
function rpMatchesOrigin(rpId, origin) {
    try {
        const hostname = new URL(origin).hostname.toLowerCase();
        const rp = rpId.toLowerCase();
        return hostname === rp || hostname.endsWith(`.${rp}`);
    } catch { return false; }
}
function parseClientData(raw, expectedType, challenge, origin) {
    if (typeof raw !== 'string' || raw.length > 8192) return false;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return false; }
    const keys = ['type', 'challenge', 'origin', 'crossOrigin'];
    return exactRecord(parsed, keys) && parsed.type === expectedType && parsed.challenge === challenge
        && parsed.origin === origin && parsed.crossOrigin === false && JSON.stringify(parsed) === raw;
}
function authData(rpId, flags, signCount) {
    const output = Buffer.alloc(37);
    digest(rpId).copy(output, 0);
    output[32] = flags;
    output.writeUInt32BE(signCount, 33);
    return output;
}
function assertionSignedBytes(authenticatorData, clientDataJSON) {
    return Buffer.concat([authenticatorData, digest(clientDataJSON)]);
}
function registrationSignedBytes(clientDataJSON, credentialId, publicKeyPem) {
    // Deliberately simulator-specific: this is not a WebAuthn attestation.
    return Buffer.concat([Buffer.from('NEXA-TEST-REGISTRATION\0'), digest(clientDataJSON),
        Buffer.from(credentialId, 'utf8'), digest(publicKeyPem)]);
}
function publicKeyIsP256(pem) {
    try {
        const key = createPublicKey(pem);
        return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
    } catch { return false; }
}

/**
 * Deterministic-by-input WebAuthn contract harness for node:test only.
 * It stores ceremony and credential state in Maps, never on disk. Supplying a
 * deterministic randomBytes source is supported only to make tests repeatable;
 * it must never be treated as an authenticator or production challenge source.
 */
export function createWebAuthnTestHarness({ clock = () => Date.now(), randomBytes = nodeRandomBytes,
    signatureVerifier = verify } = {}) {
    if (typeof clock !== 'function' || typeof randomBytes !== 'function' || typeof signatureVerifier !== 'function')
        throw new TypeError('harness_options_invalid');
    const ceremonies = new Map();
    const credentials = new Map();
    const issuedChallenges = new Set();

    function nonce(size) {
        const bytes = randomBytes(size);
        if (!Buffer.isBuffer(bytes) || bytes.length !== size) throw new TypeError('test_random_source_invalid');
        return Buffer.from(bytes);
    }

    function createSyntheticAuthenticator(input) {
        if (!exactRecord(input, ['installationId', 'principalId', 'rpId', 'origin']))
            throw new TypeError('synthetic_authenticator_invalid');
        const { installationId, principalId, rpId, origin } = input;
        if (!TEST_ID.test(installationId ?? '') || !TEST_ID.test(principalId ?? '')
            || typeof rpId !== 'string' || !/^[a-z0-9.-]{1,253}$/iu.test(rpId)
            || !validOrigin(origin) || !rpMatchesOrigin(rpId, origin)) throw new TypeError('synthetic_authenticator_invalid');
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const authenticator = Object.freeze(Object.create(null));
        authenticators.set(authenticator, { installationId, principalId, rpId, origin,
            credentialId: b64url(nonce(24)), privateKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
            signCount: 0, userPresent: true, userVerified: true, status: 'active' });
        return authenticator;
    }

    function beginCeremony(input) {
        const keys = ['installationId', 'principalId', 'purpose', 'operationFingerprint', 'rpId', 'origin', 'ttlMs', 'requireUserVerification', 'credentialId'];
        if (!exactRecord(input, keys) || !TEST_ID.test(input.installationId ?? '')
            || !TEST_ID.test(input.principalId ?? '') || !PURPOSES.has(input.purpose)
            || !FINGERPRINT.test(input.operationFingerprint ?? '') || typeof input.rpId !== 'string'
            || !/^[a-z0-9.-]{1,253}$/iu.test(input.rpId) || !validOrigin(input.origin)
            || !rpMatchesOrigin(input.rpId, input.origin) || !Number.isSafeInteger(input.ttlMs)
            || input.ttlMs < 1 || input.ttlMs > MAX_TTL_MS || typeof input.requireUserVerification !== 'boolean'
            || !(input.credentialId === null || (typeof input.credentialId === 'string' && /^[A-Za-z0-9_-]{20,100}$/u.test(input.credentialId))))
            return fail('request_invalid');
        if ((input.purpose === 'registration') !== (input.credentialId === null)) return fail('credential_context_invalid');
        const now = clock();
        if (!Number.isSafeInteger(now) || now < 0) return fail('clock_invalid');
        let challenge;
        try {
            for (let attempt = 0; attempt < 8; attempt += 1) {
                const candidate = b64url(nonce(32));
                if (!issuedChallenges.has(candidate)) { challenge = candidate; break; }
            }
        } catch { return fail('challenge_generation_failed'); }
        if (!challenge) return fail('challenge_collision');
        let ceremonyId;
        try {
            for (let attempt = 0; attempt < 8; attempt += 1) {
                const candidate = randomUUID();
                if (!ceremonies.has(candidate)) { ceremonyId = candidate; break; }
            }
        } catch { return fail('ceremony_id_generation_failed'); }
        if (!ceremonyId) return fail('ceremony_id_collision');
        issuedChallenges.add(challenge);
        ceremonies.set(ceremonyId, { ceremonyId, installationId: input.installationId,
            principalId: input.principalId, purpose: input.purpose, operationFingerprint: input.operationFingerprint,
            rpId: input.rpId, origin: input.origin, challenge, issuedAt: now, expiresAt: now + input.ttlMs,
            requireUserVerification: input.requireUserVerification, credentialId: input.credentialId, state: 'pending' });
        return success('ceremony_issued', { ceremonyId, request: frozen({ ceremonyId,
            challenge, rpId: input.rpId, origin: input.origin,
            type: input.purpose === 'registration' ? 'webauthn.create' : 'webauthn.get',
            requireUserVerification: input.requireUserVerification, expiresAt: now + input.ttlMs }) });
    }

    function responseBase(authenticator, ceremonyId, type) {
        const auth = authenticator && typeof authenticator === 'object' ? authenticators.get(authenticator) : null;
        const ceremony = ceremonies.get(ceremonyId);
        if (!auth || !ceremony || ceremony.state !== 'pending'
            || (ceremony.purpose === 'registration') !== (type === 'webauthn.create')
            || auth.installationId !== ceremony.installationId || auth.principalId !== ceremony.principalId
            || auth.rpId !== ceremony.rpId || auth.origin !== ceremony.origin
            || (ceremony.credentialId !== null && auth.credentialId !== ceremony.credentialId)) return null;
        const clientDataJSON = JSON.stringify({ type, challenge: ceremony.challenge, origin: ceremony.origin, crossOrigin: false });
        return { auth, ceremony, clientDataJSON };
    }

    function createSyntheticRegistrationResponse(authenticator, ceremonyId, options = {}) {
        const base = responseBase(authenticator, ceremonyId, 'webauthn.create');
        if (!base || !optionalRecord(options, ['userPresent', 'userVerified'])) return null;
        const { auth, clientDataJSON } = base;
        const userPresent = options.userPresent ?? auth.userPresent;
        const userVerified = options.userVerified ?? auth.userVerified;
        const flags = (userPresent ? 0x01 : 0) | (userVerified ? 0x04 : 0);
        const signature = sign('sha256', registrationSignedBytes(clientDataJSON, auth.credentialId, auth.publicKeyPem), auth.privateKey);
        return frozen({ type: 'synthetic_registration', ceremonyId, clientDataJSON,
            authenticatorData: b64url(authData(auth.rpId, flags, 0)), credentialId: auth.credentialId,
            publicKeyPem: auth.publicKeyPem, signature: b64url(signature) });
    }

    function consumeCeremony(ceremonyId, type) {
        const ceremony = ceremonies.get(ceremonyId);
        if (!ceremony) return { error: fail('ceremony_unknown') };
        if (ceremony.state !== 'pending') return { error: fail(ceremony.state === 'consumed' ? 'ceremony_replayed' : 'ceremony_not_pending') };
        // Consume before checking caller-controlled response fields: any attempt burns it.
        ceremony.state = 'consumed';
        const now = clock();
        if (!Number.isSafeInteger(now) || now < 0) return { error: fail('clock_invalid') };
        if (now >= ceremony.expiresAt) return { error: fail('challenge_expired') };
        if ((ceremony.purpose === 'registration') !== (type === 'registration')) return { error: fail('ceremony_type_mismatch') };
        return { ceremony };
    }

    function verifySyntheticRegistration(response) {
        let ceremonyIdDescriptor;
        try {
            ceremonyIdDescriptor = response && typeof response === 'object'
                ? Object.getOwnPropertyDescriptor(response, 'ceremonyId') : null;
        } catch { return fail('response_invalid'); }
        if (!ceremonyIdDescriptor || !Object.hasOwn(ceremonyIdDescriptor, 'value')
            || typeof ceremonyIdDescriptor.value !== 'string') return fail('response_invalid');
        const ceremonyId = ceremonyIdDescriptor.value;
        const consumed = consumeCeremony(ceremonyId, 'registration');
        if (consumed.error) return consumed.error;
        const { ceremony } = consumed;
        if (!exactRecord(response, ['type', 'ceremonyId', 'clientDataJSON', 'authenticatorData', 'credentialId', 'publicKeyPem', 'signature'])
            || response.type !== 'synthetic_registration' || !parseClientData(response.clientDataJSON,
                'webauthn.create', ceremony.challenge, ceremony.origin)
            || !validB64url(response.authenticatorData) || !validB64url(response.signature)
            || typeof response.credentialId !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/u.test(response.credentialId)
            || !publicKeyIsP256(response.publicKeyPem)) return fail('registration_response_invalid');
        const authDataBytes = Buffer.from(response.authenticatorData, 'base64url');
        if (authDataBytes.length !== 37) return fail('authenticator_data_invalid');
        if (!authDataBytes.subarray(0, 32).equals(digest(ceremony.rpId))) return fail('rp_id_hash_mismatch');
        const flags = authDataBytes[32];
        if ((flags & 0x01) === 0) return fail('user_presence_required');
        if (ceremony.requireUserVerification && (flags & 0x04) === 0) return fail('user_verification_required');
        if (authDataBytes.readUInt32BE(33) !== 0) return fail('registration_counter_invalid');
        if (credentials.has(response.credentialId)) return fail('credential_duplicate');
        const publicKey = createPublicKey(response.publicKeyPem);
        let proofOK;
        try {
            proofOK = signatureVerifier('sha256', registrationSignedBytes(response.clientDataJSON,
                response.credentialId, response.publicKeyPem), publicKey, Buffer.from(response.signature, 'base64url'));
        } catch { return fail('signature_verification_failed'); }
        if (!proofOK) return fail('registration_proof_invalid');
        credentials.set(response.credentialId, { credentialId: response.credentialId,
            installationId: ceremony.installationId, principalId: ceremony.principalId, rpId: ceremony.rpId,
            publicKeyPem: response.publicKeyPem, status: 'active', signCount: 0, synthetic: true });
        return success('registration_accepted_synthetic', { credentialId: response.credentialId,
            binding: frozen({ installationId: ceremony.installationId, principalId: ceremony.principalId,
                credentialId: response.credentialId, state: 'hypothetical_synthetic' }) });
    }

    function createSyntheticAssertionResponse(authenticator, ceremonyId, options = {}) {
        const base = responseBase(authenticator, ceremonyId, 'webauthn.get');
        if (!base || !optionalRecord(options, ['userPresent', 'userVerified', 'signCount'])) return null;
        const { auth, ceremony, clientDataJSON } = base;
        const registered = credentials.get(auth.credentialId);
        if (!registered || registered.status !== 'active') return null;
        const userPresent = options.userPresent ?? auth.userPresent;
        const userVerified = options.userVerified ?? auth.userVerified;
        const signCount = options.signCount ?? ++auth.signCount;
        const flags = (userPresent ? 0x01 : 0) | (userVerified ? 0x04 : 0);
        const authenticatorData = authData(auth.rpId, flags, signCount);
        const signature = sign('sha256', assertionSignedBytes(authenticatorData, clientDataJSON), auth.privateKey);
        return frozen({ type: 'synthetic_assertion', ceremonyId, credentialId: auth.credentialId,
            clientDataJSON, authenticatorData: b64url(authenticatorData), signature: b64url(signature) });
    }

    function verifySyntheticAssertion(ceremonyId, response, expectedContext) {
        const consumed = consumeCeremony(ceremonyId, 'assertion');
        if (consumed.error) return consumed.error;
        const { ceremony } = consumed;
        if (!exactRecord(expectedContext, ['installationId', 'principalId', 'purpose', 'operationFingerprint'])
            || expectedContext.installationId !== ceremony.installationId || expectedContext.principalId !== ceremony.principalId
            || expectedContext.purpose !== ceremony.purpose || expectedContext.operationFingerprint !== ceremony.operationFingerprint)
            return fail('ceremony_context_mismatch');
        if (!exactRecord(response, ['type', 'ceremonyId', 'credentialId', 'clientDataJSON', 'authenticatorData', 'signature'])
            || response.type !== 'synthetic_assertion' || response.ceremonyId !== ceremonyId
            || response.credentialId !== ceremony.credentialId || !validB64url(response.authenticatorData)
            || !validB64url(response.signature) || !parseClientData(response.clientDataJSON,
                'webauthn.get', ceremony.challenge, ceremony.origin)) return fail('assertion_response_invalid');
        const credential = credentials.get(response.credentialId);
        if (!credential) return fail('credential_unknown');
        if (credential.status !== 'active') return fail('credential_revoked');
        if (credential.installationId !== ceremony.installationId || credential.principalId !== ceremony.principalId
            || credential.rpId !== ceremony.rpId) return fail('credential_binding_mismatch');
        const authenticatorData = Buffer.from(response.authenticatorData, 'base64url');
        if (authenticatorData.length !== 37) return fail('authenticator_data_invalid');
        if (!authenticatorData.subarray(0, 32).equals(digest(ceremony.rpId))) return fail('rp_id_hash_mismatch');
        const flags = authenticatorData[32];
        if ((flags & 0x01) === 0) return fail('user_presence_required');
        if (ceremony.requireUserVerification && (flags & 0x04) === 0) return fail('user_verification_required');
        const signCount = authenticatorData.readUInt32BE(33);
        if (credential.signCount > 0 && signCount > 0 && signCount <= credential.signCount)
            return fail('signature_counter_not_increasing');
        let signatureOK;
        try {
            signatureOK = signatureVerifier('sha256', assertionSignedBytes(authenticatorData, response.clientDataJSON),
                createPublicKey(credential.publicKeyPem), Buffer.from(response.signature, 'base64url'));
        } catch { return fail('signature_verification_failed'); }
        if (!signatureOK) return fail('signature_invalid');
        if (signCount > credential.signCount) credential.signCount = signCount;
        return success('assertion_accepted_synthetic', { ceremonyId,
            principalId: ceremony.principalId, installationId: ceremony.installationId,
            purpose: ceremony.purpose, operationFingerprint: ceremony.operationFingerprint,
            binding: 'hypothetical_synthetic' });
    }

    function terminateCeremony(ceremonyId, outcome) {
        const ceremony = ceremonies.get(ceremonyId);
        if (!ceremony) return fail('ceremony_unknown');
        if (ceremony.state !== 'pending') return fail('ceremony_replayed');
        ceremony.state = 'consumed';
        if (!TERMINAL_OUTCOMES.has(outcome)) return fail('ceremony_outcome_invalid');
        return fail(outcome === 'timed_out' ? 'ceremony_timed_out' : `ceremony_${outcome}`);
    }

    function revokeSyntheticCredential(credentialId) {
        const credential = credentials.get(credentialId);
        if (!credential) return fail('credential_unknown');
        credential.status = 'revoked';
        return success('credential_revoked_synthetic');
    }

    function evaluateExecutionRequest(request) {
        void request;
        return fail('real_execution_unavailable');
    }

    return Object.freeze({ createSyntheticAuthenticator, beginCeremony,
        createSyntheticRegistrationResponse, verifySyntheticRegistration,
        createSyntheticAssertionResponse, verifySyntheticAssertion,
        terminateCeremony, revokeSyntheticCredential, evaluateExecutionRequest });
}
