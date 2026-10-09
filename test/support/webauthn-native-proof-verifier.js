import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

export const LAB_RP_ID = 'nexa-memory-lab.test';
export const LAB_ORIGIN = 'https://nexa-memory-lab.test';
const MAX_JSON = 262144, MAX_CBOR = 131072, MAX_NODES = 4096, MAX_DEPTH = 16;
const denied = (code, fields = {}) => Object.freeze({ valid: false, code, ...fields, laboratoryOnly: true,
    originBinding: 'caller_supplied_unverified', authorization: 'DENY', executable: false, persistencePerformed: false });
const accepted = (code, fields = {}) => Object.freeze({ valid: true, code, ...fields, laboratoryOnly: true,
    originBinding: 'caller_supplied_unverified', authorization: 'DENY', executable: false, persistencePerformed: false });

function dataRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw Error('response_shape_invalid');
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string') || keys.length > 32) throw Error('response_shape_invalid');
    const copy = Object.create(null);
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('response_shape_invalid');
        copy[key] = descriptor.value;
    }
    return copy;
}
function b64(value, limit = MAX_JSON) {
    if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(limit * 4 / 3) + 4
        || !/^[A-Za-z0-9_-]+$/u.test(value)) throw Error('encoding_invalid');
    const out = Buffer.from(value, 'base64url');
    if (out.length > limit || out.toString('base64url') !== value) throw Error('encoding_invalid');
    return out;
}
function noDuplicateJson(text) {
    let i = 0, count = 0;
    const ws = () => { while (i < text.length && [9, 10, 13, 32].includes(text.charCodeAt(i))) i++; };
    function str() {
        const start = i++;
        while (i < text.length) {
            const c = text.charCodeAt(i++);
            if (c === 34) return JSON.parse(text.slice(start, i));
            if (c === 92) {
                const e = text[i++];
                if (e === 'u') { if (!/^[0-9a-f]{4}$/iu.test(text.slice(i, i + 4))) throw Error('json_invalid'); i += 4; }
                else if (!'"\\/bfnrt'.includes(e)) throw Error('json_invalid');
            } else if (c < 32) throw Error('json_invalid');
        }
        throw Error('json_invalid');
    }
    function val(depth) {
        if (++count > MAX_NODES || depth > MAX_DEPTH) throw Error('json_limits');
        ws();
        if (text[i] === '"') { str(); return; }
        if (text[i] === '{') {
            i++; ws(); const keys = new Set();
            if (text[i] === '}') { i++; return; }
            for (;;) {
                ws(); if (text[i] !== '"') throw Error('json_invalid');
                const key = str(); if (keys.has(key)) throw Error('json_duplicate_key'); keys.add(key);
                ws(); if (text[i++] !== ':') throw Error('json_invalid');
                val(depth + 1); ws();
                if (text[i] === '}') { i++; return; }
                if (text[i++] !== ',') throw Error('json_invalid');
            }
        }
        if (text[i] === '[') {
            i++; ws(); if (text[i] === ']') { i++; return; }
            for (;;) { val(depth + 1); ws(); if (text[i] === ']') { i++; return; } if (text[i++] !== ',') throw Error('json_invalid'); }
        }
        const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(i));
        if (!match) throw Error('json_invalid');
        i += match[0].length;
    }
    val(0); ws(); if (i !== text.length) throw Error('json_invalid');
}
function strictJson(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_JSON) throw Error('json_limits');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    noDuplicateJson(text);
    return JSON.parse(text);
}
function cbor(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_CBOR) throw Error('cbor_limits');
    let i = 0, nodes = 0;
    function take(n) { if (!Number.isSafeInteger(n) || n < 0 || n > bytes.length - i) throw Error('cbor_truncated'); const v = bytes.subarray(i, i + n); i += n; return v; }
    function arg(a) {
        if (a < 24) return a;
        const n = ({24:1,25:2,26:4,27:8})[a]; if (!n) throw Error('cbor_indefinite_or_reserved');
        let v = 0n; for (const b of take(n)) v = (v << 8n) | BigInt(b);
        if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('cbor_integer_range');
        return Number(v);
    }
    function item(depth = 0) {
        if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw Error('cbor_limits');
        const first = take(1)[0], major = first >> 5, a = first & 31;
        if (major === 7) { if (a === 20) return false; if (a === 21) return true; if (a === 22) return null; throw Error('cbor_simple_unsupported'); }
        const n = arg(a);
        if (major === 0) return n;
        if (major === 1) return -1 - n;
        if (major === 2) return Buffer.from(take(n));
        if (major === 3) return new TextDecoder('utf-8', { fatal: true }).decode(take(n));
        if (major === 4) { if (n > MAX_NODES) throw Error('cbor_limits'); return Array.from({length:n}, () => item(depth + 1)); }
        if (major === 5) {
            if (n > MAX_NODES) throw Error('cbor_limits');
            const m = new Map(); for (let j = 0; j < n; j++) { const k = item(depth + 1); if (m.has(k)) throw Error('cbor_duplicate_key'); m.set(k, item(depth + 1)); }
            return m;
        }
        throw Error('cbor_type_unsupported');
    }
    const value = item(); return { value, bytesRead: i };
}
function clientData(encoded, type, challenge) {
    const raw = b64(encoded, 16384), d = strictJson(raw);
    if ((!d || typeof d !== 'object' || Array.isArray(d)) || d.type !== type || d.challenge !== challenge || d.origin !== LAB_ORIGIN
        || (Object.hasOwn(d, 'crossOrigin') && d.crossOrigin !== false)
        || Object.keys(d).some(k => !['type', 'challenge', 'origin', 'crossOrigin'].includes(k)))
        throw Error('client_data_mismatch');
    return raw;
}
function authData(bytes, registration) {
    if (bytes.length < 37) throw Error('authenticator_data_invalid');
    const expected = createHash('sha256').update(LAB_RP_ID).digest(), rp = bytes.subarray(0, 32);
    if (!timingSafeEqual(expected, rp)) throw Error('rp_id_hash_mismatch');
    const flags = bytes[32], up = !!(flags & 1), uv = !!(flags & 4), be = !!(flags & 8), bs = !!(flags & 16);
    if ((flags & 0x22) || !up || !uv || (bs && !be)) throw Error('user_verification_required');
    const signCount = bytes.readUInt32BE(33);
    if (!registration) {
        if ((flags & 0xc0) || bytes.length !== 37) throw Error('assertion_extensions_unsupported');
        return { up, uv, signCount };
    }
    if (!(flags & 0x40) || (flags & 0x80) || bytes.length < 55) throw Error('attested_credential_data_invalid');
    const length = bytes.readUInt16BE(53), start = 55, end = start + length;
    if (!length || end >= bytes.length) throw Error('credential_id_invalid');
    const id = Buffer.from(bytes.subarray(start, end)), cose = cbor(bytes.subarray(end));
    if (end + cose.bytesRead !== bytes.length || !(cose.value instanceof Map)) throw Error('cose_key_invalid');
    const k = cose.value;
    if (k.size !== 5 || k.get(1) !== 2 || k.get(3) !== -7 || k.get(-1) !== 1
        || !Buffer.isBuffer(k.get(-2)) || k.get(-2).length !== 32
        || !Buffer.isBuffer(k.get(-3)) || k.get(-3).length !== 32) throw Error('cose_key_unsupported');
    const publicKey = createPublicKey({ key: { kty:'EC', crv:'P-256', x:k.get(-2).toString('base64url'), y:k.get(-3).toString('base64url') }, format:'jwk' });
    return { up, uv, signCount, id, publicKey };
}
function nativeJson(value, fields) {
    let d;
    if (typeof value === 'string') d = strictJson(Buffer.from(value, 'utf8'));
    else d = dataRecord(value);
    if (d.type !== 'public-key') throw Error('response_shape_invalid');
    d = { ...d, response: dataRecord(d.response) };
    if (!fields.every(k => typeof d.response[k] === 'string')) throw Error('response_shape_invalid');
    return d;
}
function failure(e) {
    let message;
    try {
        if (e !== null && (typeof e === 'object' || typeof e === 'function')) {
            const descriptor = Object.getOwnPropertyDescriptor(e, 'message');
            if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string') message = descriptor.value;
        }
    } catch { /* hostile thrown values must not escape the fail-closed result */ }
    const allowed = new Set(['encoding_invalid','json_invalid','json_limits','json_duplicate_key','cbor_limits',
        'cbor_truncated','cbor_indefinite_or_reserved','cbor_integer_range','cbor_simple_unsupported',
        'cbor_duplicate_key','cbor_type_unsupported','client_data_mismatch','rp_id_hash_mismatch',
        'user_verification_required','attested_credential_data_invalid','credential_id_invalid',
        'cose_key_invalid','cose_key_unsupported','response_shape_invalid','assertion_extensions_unsupported',
        'credential_id_mismatch','signature_invalid','attestation_format_unsupported','authenticator_data_invalid']);
    return denied(allowed.has(message) ? message : 'proof_invalid');
}
function validChallenge(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{22,128}$/u.test(value); }

export function verifyWindowsNativeRegistration(responseJson, expectedChallenge) {
    try {
        if (!validChallenge(expectedChallenge)) return denied('challenge_invalid');
        const d = nativeJson(responseJson, ['clientDataJSON','attestationObject']);
        clientData(d.response.clientDataJSON, 'webauthn.create', expectedChallenge);
        const bytes = b64(d.response.attestationObject, MAX_CBOR), att = cbor(bytes);
        if (att.bytesRead !== bytes.length || !(att.value instanceof Map) || att.value.size !== 3
            || att.value.get('fmt') !== 'none' || !(att.value.get('authData') instanceof Buffer)
            || !(att.value.get('attStmt') instanceof Map) || att.value.get('attStmt').size)
            return denied('attestation_format_unsupported');
        const parsed = authData(att.value.get('authData'), true), id = parsed.id.toString('base64url');
        if (d.id !== id || d.rawId !== id) return denied('credential_id_mismatch');
        return accepted('registration_structure_valid', { credentialId:id, publicKey:parsed.publicKey,
            userPresence:parsed.up, userVerification:parsed.uv, signCount:parsed.signCount, attestationTrust:'none_unverified' });
    } catch (e) { return failure(e); }
}
export function verifyWindowsNativeAssertion(responseJson, context) {
    try {
        const options = dataRecord(context);
        const registeredCredential = dataRecord(options.registeredCredential);
        if (!validChallenge(options.expectedChallenge) || typeof registeredCredential.credentialId !== 'string'
            || !registeredCredential.publicKey || registeredCredential.rpId !== LAB_RP_ID) return denied('assertion_context_invalid');
        const expectedChallenge = options.expectedChallenge;
        const d = nativeJson(responseJson, ['clientDataJSON','authenticatorData','signature']);
        const id = b64(registeredCredential.credentialId, 1024).toString('base64url');
        if (d.id !== id || d.rawId !== id) throw Error('credential_id_mismatch');
        const client = clientData(d.response.clientDataJSON, 'webauthn.get', expectedChallenge);
        const data = b64(d.response.authenticatorData, 1024), sig = b64(d.response.signature, 1024);
        const flags = authData(data, false);
        const signed = Buffer.concat([data, createHash('sha256').update(client).digest()]);
        if (!verify('sha256', signed, registeredCredential.publicKey, sig)) throw Error('signature_invalid');
        return accepted('assertion_signature_valid', { credentialId:id, userPresence:flags.up,
            userVerification:flags.uv, signCount:flags.signCount, signatureValid:true });
    } catch (e) { return failure(e); }
}
