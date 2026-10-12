import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizationRequirement } from '../src/core/agent.js';

test('authorization requirement marks read-only operations retry-safe', () => {
    assert.deepEqual(authorizationRequirement('spotify_get_devices', {
        error: { code: 'spotify_auth_required' },
    }), {
        provider: 'spotify', state: 'not_connected', reason: 'spotify_auth_required', canConnect: true, retrySafe: true,
    });
    assert.deepEqual(authorizationRequirement('search_emails', {
        error: { code: 'email_not_connected' },
    }), {
        provider: 'microsoft', state: 'not_connected', reason: 'email_not_connected', canConnect: true, retrySafe: true,
    });
});

test('authorization requirement never offers automatic or unsafe retry for writes', () => {
    assert.deepEqual(authorizationRequirement('send_email', {
        error: { code: 'email_not_connected' },
    }), {
        provider: 'microsoft', state: 'not_connected', reason: 'email_not_connected', canConnect: true, retrySafe: false,
    });
    assert.deepEqual(authorizationRequirement('spotify_play', {
        error: { code: 'spotify_auth_expired' },
    }), {
        provider: 'spotify', state: 'reauthorization_required', reason: 'spotify_auth_expired', canConnect: true, retrySafe: false,
    });
});

test('permission failures require a different permission decision and cannot be retried', () => {
    assert.deepEqual(authorizationRequirement('list_calendar_events', {
        error: { code: 'microsoft_access_denied' },
    }), {
        provider: 'microsoft', state: 'insufficient_permissions', reason: 'microsoft_access_denied', canConnect: false, retrySafe: false,
    });
    assert.equal(authorizationRequirement(null, { error: { code: 'microsoft_access_denied' } }), null);
    assert.equal(authorizationRequirement('spotify_play', { error: { code: 'spotify_forbidden', status: 403 } }), null,
        'HTTP 403 alone is not proof that Spotify authorization scopes are insufficient');
});
