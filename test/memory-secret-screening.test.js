import { terminalTests, grantFor } from '../test-support/memory-terminal.js';
const test = terminalTests(import.meta.url);
import assert from 'node:assert/strict';
import { screenMemorySecret } from '../src/memory/secret-screening.js';
import { createMemoryService } from '../src/memory/service.js';

const now = '2032-06-12T10:30:00.000Z';
const prop = value => ({ kind: 'fact', subject: { type: 'owner' }, predicate: 'account.note', object: { type: 'text', value },
    valid_from: null, valid_to: null, compatibility: { category: 'fact', key: 'account_note' } });
const idFactory = prefix => `${prefix}_00000001-1111-4111-8111-111111111111`;

test('conservative scanner detects common API keys, bearer and access tokens', () => {
    for (const value of ['key sk-proj-abcdefghijklmnopqrstuvwxyz123456', 'Authorization: Bearer abcdefghijklmnop0123456789',
        'api_key = abcdefghijklmnop123456', 'access_token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.ABCDEFGHIJKLMNOPQRSTUV']) {
        assert.equal(screenMemorySecret(value).reason, 'memory_secret_suspected');
    }
});
test('scanner detects private keys and clearly assigned credential passwords', () => {
    assert.equal(screenMemorySecret('-----BEGIN OPENSSH PRIVATE KEY-----\nfake fixture\n').kind, 'private_key');
    assert.equal(screenMemorySecret('password: SyntheticCredentialValue123').kind, 'password');
    assert.equal(screenMemorySecret('client_secret=FictionalSecretValue123').reason, 'memory_secret_suspected');
});
test('ordinary documentation and discussion about credentials are allowed', () => {
    for (const value of ['Documentation explains how API keys are created and rotated.', 'A password is required when you sign in.',
        'Bearer tokens appear in the authorization header.', 'The string sk-short is only an example.']) assert.equal(screenMemorySecret(value).safe, true);
});
test('service rejects a likely secret without echoing it or touching the repository', async () => {
    let commits = 0;
    const repository = { open: async () => {}, readSnapshot: async () => { throw new Error('must not read'); },
        commit: async () => { commits++; }, close: async () => {} };
    const service = createMemoryService({ repository, now: () => now, idFactory });
    const value = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
    const proposal = prop(value);
    const auth = await grantFor(service, proposal);
    const result = await service.remember({ proposal }, auth);
    assert.equal(result.error.code, 'memory_secret_suspected'); assert.equal(JSON.stringify(result).includes(value), false);
    assert.equal(commits, 0);
});
