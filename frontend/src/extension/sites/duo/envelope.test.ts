import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDuoEnvelope, DUO_PUBLIC_KEY } from './envelope';

import { receiveEnvelope, testPublicKey } from './test-server';

describe('Duo encryption envelope', () => {
  it('uses the audited public SPKI fingerprint', () => {
    expect(createHash('sha256').update(Buffer.from(DUO_PUBLIC_KEY, 'base64')).digest('hex'))
      .toBe('f3f43959d3de920289d4ccc1b45db747a4478daf49e9ce5490ea7f542422af33');
  });

  it('interoperates with an independent receiver in both directions', async () => {
    const request = { api: 'synthetic', data: { keyword: '中文检索', page: 1 } };
    const encrypted = await createDuoEnvelope(request, testPublicKey);
    expect(Object.keys(encrypted.body).sort()).toEqual(['key', 'params']);
    const receiver = receiveEnvelope(JSON.stringify(encrypted.body));
    expect(receiver.key.length).toBe(32);
    expect(receiver.iv.length).toBe(16);
    expect(receiver.payload).toEqual(request);
    const response = { status: 0, result: { entry: [], timestamp: 123 } };
    await expect(encrypted.decrypt(receiver.respond(response))).resolves.toEqual(response);
  });

  it('rejects tampered ciphertext and uses fresh key/IV material for every request', async () => {
    const first = await createDuoEnvelope({}, testPublicKey);
    const second = await createDuoEnvelope({}, testPublicKey);
    const receiver = receiveEnvelope(JSON.stringify(first.body));
    const other = receiveEnvelope(JSON.stringify(second.body));
    expect(receiver.key.equals(other.key)).toBe(false);
    expect(receiver.iv.equals(other.iv)).toBe(false);
    const response = Buffer.from(receiver.respond({ status: 0 }), 'base64');
    response[response.length - 1] ^= 1;
    await expect(first.decrypt(response.toString('base64'))).rejects.toThrow();
  });
});
