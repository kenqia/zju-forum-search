// Offline protocol experiment. No requests, browser state, or real credentials.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, createPublicKey, createCipheriv, createDecipheriv, privateDecrypt, webcrypto } from 'node:crypto';

const bundlePath = process.argv[2];
if (bundlePath) {
  const bundle = await readFile(bundlePath);
  assert.equal(createHash('sha256').update(bundle).digest('hex'),
    '6d26f218a242a071206e9a4efb39c1ed5939f55e5405d549c37e873aef6bde7e', 'Public bundle version differs; re-audit before updating this fingerprint');
  const text = bundle.toString('utf8');
  const publicKey = text.match(/zR=`([A-Za-z0-9+/=\s]+)`/u)?.[1];
  assert.ok(publicKey, 'Expected public SPKI declaration');
  const der = Buffer.from(publicKey, 'base64');
  assert.equal(createHash('sha256').update(der).digest('hex'),
    'f3f43959d3de920289d4ccc1b45db747a4478daf49e9ce5490ea7f542422af33');
  assert.equal(createPublicKey({ key: der, format: 'der', type: 'spki' }).asymmetricKeyDetails.modulusLength, 4096);
  assert.ok(text.includes('new Uint8Array(16)'));
  assert.ok(text.includes('name:"RSA-OAEP",hash:{name:"SHA-256"}'));
  assert.ok(text.includes('XR(await o.text(),b.aesKey,b.aesIv)'));
  console.log('Public bundle and SPKI fingerprints verified (4096-bit RSA).');
}

const { subtle } = webcrypto;
const rsa = await subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 4096,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
const aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const iv = webcrypto.getRandomValues(new Uint8Array(16));
const rawKey = Buffer.from(await subtle.exportKey('raw', aes));
const syntheticRequest = { api: 'offline-synthetic', data: { keyword: '合成检索词', page: 1, limit: 20 } };
const plaintext = Buffer.from(JSON.stringify(syntheticRequest));
const encrypted = Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv }, aes, plaintext));
assert.equal(encrypted.length, plaintext.length + 16, 'WebCrypto appends a 128-bit GCM tag');
const envelope = {
  params: encrypted.toString('base64'),
  key: Buffer.from(await subtle.encrypt({ name: 'RSA-OAEP' }, rsa.publicKey,
    Buffer.from(`${rawKey.toString('base64')}|${Buffer.from(iv).toString('base64')}`))).toString('base64'),
};

// Independent Node/OpenSSL receiver checks WebCrypto's outgoing wire format.
const privateDer = Buffer.from(await subtle.exportKey('pkcs8', rsa.privateKey));
const keyText = privateDecrypt({ key: privateDer, format: 'der', type: 'pkcs8', oaepHash: 'sha256' },
  Buffer.from(envelope.key, 'base64')).toString('utf8');
const [receiverKey, receiverIv] = keyText.split('|').map((part) => Buffer.from(part, 'base64'));
assert.equal(receiverKey.length, 32);
assert.equal(receiverIv.length, 16);
const incoming = Buffer.from(envelope.params, 'base64');
const decipher = createDecipheriv('aes-256-gcm', receiverKey, receiverIv);
decipher.setAuthTag(incoming.subarray(-16));
const decoded = Buffer.concat([decipher.update(incoming.subarray(0, -16)), decipher.final()]);
assert.deepEqual(JSON.parse(decoded.toString('utf8')), syntheticRequest);

// Mirror the site's same-key/IV response decoding for interoperability only.
const syntheticResponse = { status: 0, msg: 'synthetic', result: { entry: [], timestamp: 123 } };
const cipher = createCipheriv('aes-256-gcm', receiverKey, receiverIv);
const response = Buffer.concat([cipher.update(JSON.stringify(syntheticResponse)), cipher.final(), cipher.getAuthTag()]);
const responseText = response.toString('base64');
assert.deepEqual(JSON.parse(Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv }, aes,
  Buffer.from(responseText, 'base64'))).toString('utf8')), syntheticResponse);
const corrupt = Buffer.from(response);
corrupt[corrupt.length - 1] ^= 1;
await assert.rejects(subtle.decrypt({ name: 'AES-GCM', iv }, aes, corrupt));
console.log('Offline request/response interoperability and corrupt-tag rejection passed. No server acceptance was tested.');
