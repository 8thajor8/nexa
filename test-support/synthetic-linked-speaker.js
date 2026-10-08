import { createHash } from 'node:crypto';
import { createTrustedSpeakerIdentityBoundary, consumeTrustedSpeakerIdentity } from '../src/core/trusted-speaker-identity.js';

const PRINCIPAL_ID = 'windows-sid:S-1-5-21-100-200-300-1001';
const VERIFIED_AT = '2036-02-03T10:00:00.000Z';

/**
 * Test-only fixture: starts from the real stdin-issued speaker capability and
 * supplies a synthetic, pre-verified Windows Hello binding. This module is
 * under test-support and is never imported by production code.
 */
export async function createSyntheticLinkedSpeakerContext({ turn, recipient, text, selfPersonId, bindingState = {} }) {
    const record = Object.freeze({ principalId: PRINCIPAL_ID, selfPersonId,
        verificationMethod: 'windows_hello_user_consent', verifiedAt: VERIFIED_AT, status: 'active' });
    bindingState.record = record;
    const boundary = createTrustedSpeakerIdentityBoundary({
        principalProvider: { async getCurrentPrincipal() { return Object.freeze({ id: PRINCIPAL_ID,
            kind: 'windows_account_sid', authenticationState: 'os_account_session_unverified',
            method: 'windows_process_token' }); } },
        windowsHelloProvider: { async verifyUser() { return Object.freeze({ status: 'unavailable' }); } },
        bindingStore: { async get(id) { return id === PRINCIPAL_ID ? bindingState.record ?? null : null; },
            async set() { throw new Error('test_fixture_read_only'); }, async revoke() { throw new Error('test_fixture_read_only'); } },
        ownerSelfProvider: { async getSelfPersonId() { return selfPersonId; } },
    });
    const resolved = await boundary.resolveTurn({ capability: turn?.speakerIdentityCapability, recipient, text });
    if (!resolved.success) return null;
    const sourceHash = createHash('sha256').update(text, 'utf8').digest('hex');
    return consumeTrustedSpeakerIdentity(resolved.capability, sourceHash);
}
