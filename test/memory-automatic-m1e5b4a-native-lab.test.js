import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LAB_ORIGIN, LAB_RP_ID, verifyWindowsNativeAssertion, verifyWindowsNativeRegistration } from './support/webauthn-native-proof-verifier.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const b64 = b => Buffer.from(b).toString('base64url');
const head = (major, n) => n < 24 ? Buffer.from([(major << 5) | n]) : Buffer.from([(major << 5) | 24, n]);
function cbor(v) {
    if (Buffer.isBuffer(v)) return Buffer.concat([head(2,v.length),v]);
    if (typeof v === 'string') { const b=Buffer.from(v); return Buffer.concat([head(3,b.length),b]); }
    if (typeof v === 'number') return head(v < 0 ? 1 : 0, v < 0 ? -1-v : v);
    if (v instanceof Map) return Buffer.concat([head(5,v.size), ...[...v].flatMap(([k,x]) => [cbor(k),cbor(x)])]);
    throw Error('fixture_unsupported');
}
const client = (type, challenge, origin=LAB_ORIGIN) => Buffer.from(JSON.stringify({type,challenge,origin,crossOrigin:false}));
function baseAuth(rp=LAB_RP_ID, flags=0x45, count=1) {
    return Buffer.concat([createHash('sha256').update(rp).digest(),Buffer.from([flags,0,0,0,count])]);
}
function registration() {
    const kp=generateKeyPairSync('ec',{namedCurve:'prime256v1'}), jwk=kp.publicKey.export({format:'jwk'});
    const cose=new Map([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x,'base64url')],[-3,Buffer.from(jwk.y,'base64url')]]);
    const cid=Buffer.from('synthetic-lab-credential'), id=b64(cid), challenge=b64(Buffer.alloc(32,7));
    const auth=Buffer.concat([baseAuth(),Buffer.alloc(16),Buffer.from([0,cid.length]),cid,cbor(cose)]);
    const att=cbor(new Map([['fmt','none'],['authData',auth],['attStmt',new Map()]]));
    return { kp,id,challenge,response:{type:'public-key',id,rawId:id,response:{
        clientDataJSON:b64(client('webauthn.create',challenge)),attestationObject:b64(att)}}};
}
function assertion(reg, opts={}) {
    const challenge=opts.challenge ?? b64(Buffer.alloc(32,9)), data=baseAuth(opts.rp ?? LAB_RP_ID,opts.flags ?? 5,2);
    const cd=client(opts.type ?? 'webauthn.get',challenge,opts.origin ?? LAB_ORIGIN);
    const sig=sign('sha256',Buffer.concat([data,createHash('sha256').update(cd).digest()]),reg.kp.privateKey);
    return {challenge,response:{type:'public-key',id:reg.id,rawId:reg.id,response:{
        clientDataJSON:b64(cd),authenticatorData:b64(data),signature:b64(sig)}}};
}
function safe(result) {
    assert.equal(result.authorization,'DENY'); assert.equal(result.executable,false);
    assert.equal(result.persistencePerformed,false); assert.equal(result.laboratoryOnly,true);
    assert.equal(result.originBinding,'caller_supplied_unverified');
}

test('synthetic registration checks fixed challenge, type, origin, RP hash, flags and ES256 key extraction',()=>{
    const r=registration(), result=verifyWindowsNativeRegistration(r.response,r.challenge);
    assert.equal(result.valid,true); assert.equal(result.attestationTrust,'none_unverified');
    assert.equal(result.credentialId,r.id); assert.equal(result.userPresence,true); assert.equal(result.userVerification,true); safe(result);
});
test('synthetic assertion verifies signature and the registered credential binding',()=>{
    const r=registration(), reg=verifyWindowsNativeRegistration(r.response,r.challenge), a=assertion(r);
    const result=verifyWindowsNativeAssertion(a.response,{expectedChallenge:a.challenge,
        registeredCredential:{credentialId:reg.credentialId,publicKey:reg.publicKey,rpId:LAB_RP_ID}});
    assert.equal(result.valid,true); assert.equal(result.signatureValid,true); assert.equal(result.userVerification,true); safe(result);
});
test('replayed proof may pass this stateless check but remains denied and non-executable',()=>{
    const r=registration(), reg=verifyWindowsNativeRegistration(r.response,r.challenge), a=assertion(r);
    const context={expectedChallenge:a.challenge,
        registeredCredential:{credentialId:reg.credentialId,publicKey:reg.publicKey,rpId:LAB_RP_ID}};
    const first=verifyWindowsNativeAssertion(a.response,context);
    const replay=verifyWindowsNativeAssertion(a.response,context);
    assert.equal(first.valid,true); assert.equal(replay.valid,true);
    safe(first); safe(replay);
});
test('altered challenge, operation type, origin and RP hash fail closed',()=>{
    const r=registration(), reg=verifyWindowsNativeRegistration(r.response,r.challenge);
    const context={registeredCredential:{credentialId:reg.credentialId,publicKey:reg.publicKey,rpId:LAB_RP_ID}};
    const a=assertion(r);
    assert.equal(verifyWindowsNativeAssertion(a.response,{...context,expectedChallenge:b64(Buffer.alloc(32,8))}).code,'client_data_mismatch');
    assert.equal(verifyWindowsNativeAssertion(assertion(r,{origin:'https://other-lab.test'}).response,{...context,expectedChallenge:a.challenge}).code,'client_data_mismatch');
    assert.equal(verifyWindowsNativeAssertion(assertion(r,{rp:'other-lab.test'}).response,{...context,expectedChallenge:a.challenge}).code,'rp_id_hash_mismatch');
    assert.equal(verifyWindowsNativeAssertion(assertion(r,{type:'webauthn.create'}).response,{...context,expectedChallenge:a.challenge}).code,'client_data_mismatch');
});
test('altered signature, credential ID and missing UV are rejected',()=>{
    const r=registration(), reg=verifyWindowsNativeRegistration(r.response,r.challenge), a=assertion(r);
    const ctx={expectedChallenge:a.challenge,registeredCredential:{credentialId:reg.credentialId,publicKey:reg.publicKey,rpId:LAB_RP_ID}};
    const changed=structuredClone(a.response), sig=Buffer.from(changed.response.signature,'base64url'); sig[sig.length-1]^=1; changed.response.signature=b64(sig);
    assert.equal(verifyWindowsNativeAssertion(changed,ctx).code,'signature_invalid');
    assert.equal(verifyWindowsNativeAssertion(a.response,{...ctx,registeredCredential:{...ctx.registeredCredential,credentialId:b64(Buffer.from('wrong'))}}).code,'credential_id_mismatch');
    const noUv=assertion(r,{flags:1});
    assert.equal(verifyWindowsNativeAssertion(noUv.response,{...ctx,expectedChallenge:noUv.challenge}).code,'user_verification_required');
});
test('registration rejects altered origin and duplicate clientData keys',()=>{
    const r=registration(), changed=structuredClone(r.response);
    const parsed=JSON.parse(Buffer.from(changed.response.clientDataJSON,'base64url').toString());
    changed.response.clientDataJSON=b64(Buffer.from(JSON.stringify({...parsed,origin:'https://other-lab.test'})));
    assert.equal(verifyWindowsNativeRegistration(changed,r.challenge).code,'client_data_mismatch');
    const duplicate=structuredClone(r.response);
    duplicate.response.clientDataJSON=b64(Buffer.from('{"type":"webauthn.create","challenge":"'+r.challenge+'","origin":"'+LAB_ORIGIN+'","origin":"https://other-lab.test"}'));
    assert.equal(verifyWindowsNativeRegistration(duplicate,r.challenge).code,'json_duplicate_key');
});
test('malformed and oversized inputs reject with safe non-executable results',()=>{
    const r=registration();
    assert.equal(verifyWindowsNativeRegistration('{}','bad').valid,false);
    const huge={type:'public-key',response:{clientDataJSON:'A'.repeat(400000),attestationObject:'AA'}};
    const result=verifyWindowsNativeRegistration(huge,r.challenge); assert.equal(result.valid,false); safe(result);
    safe(verifyWindowsNativeAssertion({},{ }));
});
test('accessor-bearing proof and context objects are rejected without invoking getters',()=>{
    const r=registration(); let called=false;
    const hostile={type:'public-key',response:r.response.response};
    Object.defineProperty(hostile,'id',{enumerable:true,get(){called=true;return r.id;}});
    const result=verifyWindowsNativeRegistration(hostile,r.challenge);
    assert.equal(result.valid,false); assert.equal(called,false); safe(result);
    const badContext={expectedChallenge:r.challenge,registeredCredential:{credentialId:r.id,
        publicKey:generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey,rpId:LAB_RP_ID}};
    Object.defineProperty(badContext,'expectedChallenge',{enumerable:true,get(){called=true;return r.challenge;}});
    const assertionResult=verifyWindowsNativeAssertion({},badContext);
    assert.equal(assertionResult.valid,false); assert.equal(called,false); safe(assertionResult);
});
test('hostile proxy traps and thrown error accessors cannot escape fail-closed handling',()=>{
    let messageRead=false;
    const hostileError={};
    Object.defineProperty(hostileError,'message',{get(){messageRead=true;throw Error('hostile_message_getter');}});
    const proof=new Proxy({}, {getPrototypeOf(){throw hostileError;}});
    const result=verifyWindowsNativeRegistration(proof,b64(Buffer.alloc(32,3)));
    assert.equal(result.valid,false); assert.equal(result.code,'proof_invalid');
    assert.equal(messageRead,false); safe(result);

    const hostileThrownValue=new Proxy({}, {getOwnPropertyDescriptor(){throw Error('descriptor trap');}});
    const descriptorTrapProof=new Proxy({}, {getPrototypeOf(){throw hostileThrownValue;}});
    const descriptorTrapResult=verifyWindowsNativeRegistration(descriptorTrapProof,b64(Buffer.alloc(32,4)));
    assert.equal(descriptorTrapResult.valid,false); assert.equal(descriptorTrapResult.code,'proof_invalid'); safe(descriptorTrapResult);
});
test('ordinary test discovery cannot launch a native ceremony and production modules do not import verifier',async()=>{
    const src=await readdir(path.join(ROOT,'src'),{recursive:true});
    assert.equal(src.some(p=>String(p).includes('webauthn-native')),false);
    const pkg=JSON.parse(await readFile(path.join(ROOT,'package.json'),'utf8'));
    assert.equal(pkg.scripts['webauthn:lab'],undefined);
    const text=await readFile(path.join(ROOT,'test/support/webauthn-native-proof-verifier.js'),'utf8');
    assert.equal(text.includes('node:child_process'),false);
    assert.equal(text.includes('WebAuthNAuthenticatorMakeCredential'),false);
});
