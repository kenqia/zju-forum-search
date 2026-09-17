/// <reference types="node" />
import { createCipheriv, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';

// Independent Node/OpenSSL receiver; no live service or credentials.
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const testPublicKey = rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

export function receiveEnvelope(body: string) {
  const envelope = JSON.parse(body);
  const wrapped = privateDecrypt({ key: rsa.privateKey, oaepHash: 'sha256' }, Buffer.from(envelope.key, 'base64')).toString('utf8');
  const [key, iv] = wrapped.split('|').map((part) => Buffer.from(part, 'base64'));
  const encrypted = Buffer.from(envelope.params, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(encrypted.subarray(-16));
  const payload = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString('utf8'));
  return { key, iv, payload, respond(value: unknown) {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  } };
}

