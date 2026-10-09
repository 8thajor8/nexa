import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify as nodeVerify } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebAuthnTestHarness } from './support/webauthn-harness.js';

const INSTALLATION = 'test_installation_alpha';
const PRINCIPAL = 'test_principal_owner';
const RP_ID = 'nexa.test';
const ORIGIN = 'https://nexa.test';
const OPERATION = 'a'.repeat(64);

function fixture() {
    let now = 1_900_000_000_000;
    let randomCounter = 0;
    const harness = createWebAuthnTestHarness({ clock: () => now,
        randomBytes(size) { randomCounter += 1; return Buffer.alloc(size, randomCounter % 255 || 1); } });
    return { harness, setNow(value) { now = value; } };
}

function ceremony(harness, overrides = {}) {
    return harness.beginCeremony({ installationId: INSTALLATION, principalId: PRINCIPAL,
        purpose: 'registration', operationFingerprint: OPERATION, rpId: RP_ID, origin: ORIGIN,
        ttlMs: 30_000, requireUserVerification: true, credentialId: null, ...overrides });
}

function register(harness, overrides = {}) {
    const authenticator = harness.createSyntheticAuthenticator({ installationId: INSTALLATION,
        principalId: PRINCIPAL, rpId: RP_ID, origin: ORIGIN, ...overrides });
    const issued = ceremony(harness, overrides.ceremonyOverrides ?? {});
    assert.equal(issued.status, 'accepted_synthetic');
    const response = harness.createSyntheticRegistrationResponse(authenticator, issued.ceremonyId);
    const result = harness.verifySyntheticRegistration(response);
    return { authenticator, issued, response, result };
}

function assertionRequest(harness, credentialId, overrides = {}) {
    return harness.beginCeremony({ installationId: INSTALLATION, principalId: PRINCIPAL,
        purpose: 'authentication', operationFingerprint: OPERATION, rpId: RP_ID, origin: ORIGIN,
        ttlMs: 30_000, requireUserVerification: true, credentialId, ...overrides });
}

function expectedContext(overrides = {}) {
    return { installationId: INSTALLATION, principalId: PRINCIPAL,
        purpose: 'authentication', operationFingerprint: OPERATION, ...overrides };
}

test('synthetic registration and assertion bind challenge, operation, RP ID, origin and principal', () => {
    const { harness } = fixture();
    const registered = register(harness);
    assert.equal(registered.result.status, 'accepted_synthetic');
    assert.equal(registered.result.binding.state, 'hypothetical_synthetic');
    const issued = assertionRequest(harness, registered.result.credentialId);
    const response = harness.createSyntheticAssertionResponse(registered.authenticator, issued.ceremonyId);
    const result = harness.verifySyntheticAssertion(issued.ceremonyId, response, expectedContext());
    assert.equal(result.status, 'accepted_synthetic');
    assert.equal(result.principalId, PRINCIPAL);
    assert.equal(result.executable, false);
    assert.equal(result.persistencePerformed, false);
    assert.equal(result.authorization, 'DENY');
    assert.equal(harness.verifySyntheticAssertion(issued.ceremonyId, response, expectedContext()).code,
        'ceremony_replayed');
});

test('fixture challenge generation is repeatable under its deterministic test byte source', () => {
    const first = fixture().harness;
    const second = fixture().harness;
    const a = ceremony(first);
    const b = ceremony(second);
    assert.equal(a.request.challenge, b.request.challenge);
});

test('same challenge cannot be issued twice by a repeated deterministic byte source', () => {
    let now = 1_900_000_000_000;
    const harness = createWebAuthnTestHarness({ clock: () => now,
        randomBytes(size) { return Buffer.alloc(size, 7); } });
    const first = ceremony(harness);
    assert.equal(first.status, 'accepted_synthetic');
    const second = ceremony(harness);
    assert.equal(second.status, 'rejected');
    assert.equal(second.code, 'challenge_collision');
    now += 1;
});

test('altered registration challenge is rejected and consumes the ceremony', () => {
    const { harness } = fixture();
    const authenticator = harness.createSyntheticAuthenticator({ installationId: INSTALLATION,
        principalId: PRINCIPAL, rpId: RP_ID, origin: ORIGIN });
    const issued = ceremony(harness);
    const response = harness.createSyntheticRegistrationResponse(authenticator, issued.ceremonyId);
    const parsed = JSON.parse(response.clientDataJSON);
    parsed.challenge = 'altered-challenge';
    const altered = { ...response, clientDataJSON: JSON.stringify(parsed) };
    assert.equal(harness.verifySyntheticRegistration(altered).code, 'registration_response_invalid');
    assert.equal(harness.verifySyntheticRegistration(response).code, 'ceremony_replayed');
});

test('verified claims are not accepted as response fields and malformed accessor inputs fail safely', () => {
    const { harness } = fixture();
    const auth = harness.createSyntheticAuthenticator({ installationId: INSTALLATION,
        principalId: PRINCIPAL, rpId: RP_ID, origin: ORIGIN });
    const issued = ceremony(harness);
    const response = harness.createSyntheticRegistrationResponse(auth, issued.ceremonyId);
    const claimBearing = { ...response, verified: true, authenticationGranted: true };
    assert.equal(harness.verifySyntheticRegistration(claimBearing).code, 'registration_response_invalid');
    assert.equal(harness.verifySyntheticRegistration(response).code, 'ceremony_replayed');

    const secondAuth = harness.createSyntheticAuthenticator({ installationId: INSTALLATION,
        principalId: PRINCIPAL, rpId: RP_ID, origin: ORIGIN });
    const secondIssued = ceremony(harness);
    const secondResponse = harness.createSyntheticRegistrationResponse(secondAuth, secondIssued.ceremonyId);
    const malformed = new Proxy(secondResponse, {
        ownKeys() { throw new Error('malformed proxy input'); },
    });
    assert.equal(harness.verifySyntheticRegistration(malformed).code, 'registration_response_invalid');
    assert.equal(harness.verifySyntheticRegistration(secondResponse).code, 'ceremony_replayed');

    const getterOnly = Object.create(null);
    Object.defineProperty(getterOnly, 'ceremonyId', { get() { throw new Error('getter must not run'); } });
    assert.equal(harness.verifySyntheticRegistration(getterOnly).code, 'response_invalid');
});

test('expired and reused challenges fail closed', () => {
    const { harness, setNow } = fixture();
    const auth = harness.createSyntheticAuthenticator({ installationId: INSTALLATION,
        principalId: PRINCIPAL, rpId: RP_ID, origin: ORIGIN });
    const issued = ceremony(harness);
    const response = harness.createSyntheticRegistrationResponse(auth, issued.ceremonyId);
    setNow(issued.request.expiresAt);
    assert.equal(harness.verifySyntheticRegistration(response).code, 'challenge_expired');
    assert.equal(harness.verifySyntheticRegistration(response).code, 'ceremony_replayed');
});

test('ceremony from another installation or principal cannot be applied to a credential', () => {
    const { harness } = fixture();
    const registered = register(harness);
    const sourceCeremony = assertionRequest(harness, registered.result.credentialId);
    const sourceResponse = harness.createSyntheticAssertionResponse(registered.authenticator, sourceCeremony.ceremonyId);
    const otherInstall = assertionRequest(harness, registered.result.credentialId, { installationId: 'test_installation_beta' });
    assert.equal(harness.createSyntheticAssertionResponse(registered.authenticator, otherInstall.ceremonyId), null);
    assert.equal(harness.verifySyntheticAssertion(otherInstall.ceremonyId, sourceResponse,
        expectedContext({ installationId: 'test_installation_beta' })).code, 'assertion_response_invalid');
    const otherPrincipal = assertionRequest(harness, registered.result.credentialId, { principalId: 'test_principal_member' });
    assert.equal(harness.createSyntheticAssertionResponse(registered.authenticator, otherPrincipal.ceremonyId), null);
});

test('operation and principal context changes after issuance are rejected and burn the ceremony', () => {
    const { harness } = fixture();
    const registered = register(harness);
    const issued = assertionRequest(harness, registered.result.credentialId);
    const response = harness.createSyntheticAssertionResponse(registered.authenticator, issued.ceremonyId);
    assert.equal(harness.verifySyntheticAssertion(issued.ceremonyId, response,
        expectedContext({ operationFingerprint: 'b'.repeat(64) })).code, 'ceremony_context_mismatch');
    assert.equal(harness.verifySyntheticAssertion(issued.ceremonyId, response, expectedContext()).code, 'ceremony_replayed');

    const second = assertionRequest(harness, registered.result.credentialId);
    const secondResponse = harness.createSyntheticAssertionResponse(registered.authenticator, second.ceremonyId);
    assert.equal(harness.verifySyntheticAssertion(second.ceremonyId, secondResponse,
        expectedContext({ principalId: 'test_principal_member' })).code, 'ceremony_context_mismatch');

    const third = assertionRequest(harness, registered.result.credentialId);
    const thirdResponse = harness.createSyntheticAssertionResponse(registered.authenticator, third.ceremonyId);
    assert.equal(harness.verifySyntheticAssertion(third.ceremonyId, thirdResponse,
        expectedContext({ purpose: 'owner_bootstrap' })).code, 'ceremony_context_mismatch');
});

test('wrong RP hash, origin, credential, and signature are rejected', () => {
    const { harness } = fixture();
    const registered = register(harness);
    const issue = () => assertionRequest(harness, registered.result.credentialId);

    let current = issue();
    let response = harness.createSyntheticAssertionResponse(registered.authenticator, current.ceremonyId);
    const data = Buffer.from(response.authenticatorData, 'base64url');
    data[0] ^= 1;
    assert.equal(harness.verifySyntheticAssertion(current.ceremonyId,
        { ...response, authenticatorData: data.toString('base64url') }, expectedContext()).code, 'rp_id_hash_mismatch');

    current = issue();
    response = harness.createSyntheticAssertionResponse(registered.authenticator, current.ceremonyId);
    const client = JSON.parse(response.clientDataJSON);
    client.origin = 'https://other.test';
    assert.equal(harness.verifySyntheticAssertion(current.ceremonyId,
        { ...response, clientDataJSON: JSON.stringify(client) }, expectedContext()).code, 'assertion_response_invalid');

    current = issue();
    response = harness.createSyntheticAssertionResponse(registered.authenticator, current.ceremonyId);
    assert.equal(harness.verifySyntheticAssertion(current.ceremonyId,
        { ...response, credentialId: 'A'.repeat(24) }, expectedContext()).code, 'assertion_response_invalid');

    current = issue();
    response = harness.createSyntheticAssertionResponse(registered.authenticator, current.ceremonyId);
    const signature = Buffer.from(response.signature, 'base64url');
    signature[0] ^= 1;
    assert.equal(harness.verifySyntheticAssertion(current.ceremonyId,
        { ...response, signature: signature.toString('base64url') }, expectedContext()).code, 'signature_invalid');

    assert.equal(assertionRequest(harness, registered.result.credentialId,
        { rpId: 'wrong.test' }).code, 'request_invalid');
    const unknown = assertionRequest(harness, 'A'.repeat(24));
    assert.equal(harness.verifySyntheticAssertion(unknown.ceremonyId, {}, expectedContext()).code,
        'assertion_response_invalid');
});

test('duplicate synthetic credential registration is rejected', () => {
    const { harness } = fixture();
    const registered = register(harness);
    const repeated = ceremony(harness);
    const response = harness.createSyntheticRegistrationResponse(registered.authenticator, repeated.ceremonyId);
    assert.equal(harness.verifySyntheticRegistration(response).code, 'credential_duplicate');
});

test('substituting a public key after registration response signing is rejected', () => {
    const { harness } = fixture();
    const first = harness.createSyntheticAuthenticator({ installationId: INSTALLATION,
        principalId: PRINCIPAL, rpId: RP_ID, origin: ORIGIN });
    const second = harness.createSyntheticAuthenticator({ installationId: INSTALLATION,
        principalId: PRINCIPAL, rpId: RP_ID, origin: ORIGIN });
    const firstIssue = ceremony(harness);
    const secondIssue = ceremony(harness);
    const firstResponse = harness.createSyntheticRegistrationResponse(first, firstIssue.ceremonyId);
    const secondResponse = harness.createSyntheticRegistrationResponse(second, secondIssue.ceremonyId);
    assert.equal(harness.verifySyntheticRegistration({ ...firstResponse,
        publicKeyPem: secondResponse.publicKeyPem }).code, 'registration_proof_invalid');
    assert.equal(harness.verifySyntheticRegistration(firstResponse).code, 'ceremony_replayed');
});

test('signature verifier exceptions fail closed after consuming the ceremony', () => {
    let throwOnVerify = false;
    const harness = createWebAuthnTestHarness({ signatureVerifier(...args) {
        if (throwOnVerify) throw new Error('synthetic verifier failure');
        return nodeVerify(...args);
    } });
    const auth = harness.createSyntheticAuthenticator({ installationId: INSTALLATION,
        principalId: PRINCIPAL, rpId: RP_ID, origin: ORIGIN });
    const registration = ceremony(harness);
    const registrationResponse = harness.createSyntheticRegistrationResponse(auth, registration.ceremonyId);
    assert.equal(harness.verifySyntheticRegistration(registrationResponse).status, 'accepted_synthetic');
    const issued = assertionRequest(harness, registrationResponse.credentialId);
    const response = harness.createSyntheticAssertionResponse(auth, issued.ceremonyId);
    throwOnVerify = true;
    assert.equal(harness.verifySyntheticAssertion(issued.ceremonyId, response, expectedContext()).code,
        'signature_verification_failed');
    assert.equal(harness.verifySyntheticAssertion(issued.ceremonyId, response, expectedContext()).code,
        'ceremony_replayed');
});

test('unknown and revoked credentials are rejected', () => {
    const { harness } = fixture();
    const registered = register(harness);
    const issued = assertionRequest(harness, registered.result.credentialId);
    const response = harness.createSyntheticAssertionResponse(registered.authenticator, issued.ceremonyId);
    assert.equal(harness.revokeSyntheticCredential(registered.result.credentialId).code, 'credential_revoked_synthetic');
    assert.equal(harness.verifySyntheticAssertion(issued.ceremonyId, response, expectedContext()).code,
        'credential_revoked');

    const unknownId = 'U'.repeat(24);
    const unknownCeremony = assertionRequest(harness, unknownId);
    const clientDataJSON = JSON.stringify({ type: 'webauthn.get', challenge: unknownCeremony.request.challenge,
        origin: ORIGIN, crossOrigin: false });
    const authenticatorData = Buffer.alloc(37);
    createHash('sha256').update(RP_ID).digest().copy(authenticatorData);
    authenticatorData[32] = 0x05;
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const signature = sign('sha256', Buffer.concat([authenticatorData,
        createHash('sha256').update(clientDataJSON).digest()]), privateKey);
    const unknownResponse = { type: 'synthetic_assertion', ceremonyId: unknownCeremony.ceremonyId,
        credentialId: unknownId, clientDataJSON,
        authenticatorData: authenticatorData.toString('base64url'), signature: signature.toString('base64url') };
    assert.equal(harness.verifySyntheticAssertion(unknownCeremony.ceremonyId,
        unknownResponse, expectedContext()).code, 'credential_unknown');
});

test('user presence and required user verification flags are enforced', () => {
    const { harness } = fixture();
    const registered = register(harness);
    let issued = assertionRequest(harness, registered.result.credentialId);
    let response = harness.createSyntheticAssertionResponse(registered.authenticator, issued.ceremonyId, { userPresent: false });
    assert.equal(harness.verifySyntheticAssertion(issued.ceremonyId, response, expectedContext()).code, 'user_presence_required');

    issued = assertionRequest(harness, registered.result.credentialId);
    response = harness.createSyntheticAssertionResponse(registered.authenticator, issued.ceremonyId, { userVerified: false });
    assert.equal(harness.verifySyntheticAssertion(issued.ceremonyId, response, expectedContext()).code, 'user_verification_required');
});

test('cancellation, timeout, denial, and ambiguous outcomes consume the ceremony', () => {
    const { harness } = fixture();
    for (const [outcome, code] of [['cancelled', 'ceremony_cancelled'], ['timed_out', 'ceremony_timed_out'],
        ['denied', 'ceremony_denied'], ['ambiguous', 'ceremony_ambiguous']]) {
        const issued = ceremony(harness);
        assert.equal(harness.terminateCeremony(issued.ceremonyId, outcome).code, code);
        assert.equal(harness.terminateCeremony(issued.ceremonyId, outcome).code, 'ceremony_replayed');
    }
});

test('execution is always denied and all outputs are non-executable and non-persistent', () => {
    const { harness } = fixture();
    const denied = harness.evaluateExecutionRequest({ mode: 'execute', operation: 'write_memory' });
    assert.equal(denied.authorization, 'DENY');
    assert.equal(denied.executable, false);
    assert.equal(denied.persistencePerformed, false);
    const issued = ceremony(harness);
    assert.equal(issued.executable, false);
    assert.equal(issued.persistencePerformed, false);
});

test('input fixtures are not mutated and untrusted verified properties are rejected', () => {
    const { harness } = fixture();
    const authInput = { installationId: INSTALLATION, principalId: PRINCIPAL, rpId: RP_ID, origin: ORIGIN };
    const authBefore = structuredClone(authInput);
    const auth = harness.createSyntheticAuthenticator(authInput);
    assert.deepEqual(authInput, authBefore);
    assert.throws(() => harness.createSyntheticAuthenticator({ ...authInput, verified: true }),
        /synthetic_authenticator_invalid/u);

    const request = { installationId: INSTALLATION, principalId: PRINCIPAL, purpose: 'registration',
        operationFingerprint: OPERATION, rpId: RP_ID, origin: ORIGIN, ttlMs: 30_000,
        requireUserVerification: true, credentialId: null };
    const requestBefore = structuredClone(request);
    const issued = harness.beginCeremony(request);
    assert.deepEqual(request, requestBefore);
    const response = harness.createSyntheticRegistrationResponse(auth, issued.ceremonyId);
    const responseBefore = structuredClone(response);
    harness.verifySyntheticRegistration(response);
    assert.deepEqual(response, responseBefore);
});

test('harness remains test-only: no production import, process, network or persistence path exists', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
    async function jsFiles(directory) {
        const entries = await readdir(directory, { withFileTypes: true });
        const nested = await Promise.all(entries.map(entry => entry.isDirectory()
            ? jsFiles(path.join(directory, entry.name))
            : entry.isFile() && entry.name.endsWith('.js') ? [path.join(directory, entry.name)] : []));
        return nested.flat();
    }
    for (const filename of await jsFiles(root)) {
        const source = await readFile(filename, 'utf8');
        assert.doesNotMatch(source, /webauthn-harness/u, path.relative(root, filename));
    }
    const source = await readFile(new URL('./support/webauthn-harness.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /node:child_process|node:fs|fetch\s*\(|https?\.request/u);
});
