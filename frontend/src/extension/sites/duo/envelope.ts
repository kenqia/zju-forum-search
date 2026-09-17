// Public SPKI from index-DtY5Q9_f.js; see docs/research/duo-alumni-api-survey.md.
export const DUO_PUBLIC_KEY =
  'MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAlgjbYFazdT2Pl3wYwUSuHTTdpWSykoXfRKXjypemSqxwYJoAfnm1HdJg8CdlUAK9UHIHGa1ru66mkcPC4mMQ8Q3kQSxUg7sK0aYmHWVzgyyktAdPeMcK3p7Kr5qnjJKhq1J1fZI9IiYf7ZfNew2URWjyM36ubM/g0D6ZnTSBXyuCYcuEElsY39s8jU0rHpwJdqwWyXcLYa46rznwzNdFgbnHst6ESAtMYHWylUbUkrS90wKADfOJuox4YsoHVhsz0tzS+xBO3Sb9v4IiSmDi9bZW410mE15YvnnFz1QeaSj6KCRFc29cJqlK45JJAzh5AmzFuBu+Fbmf/zjoRv1Vty84pVRs5UCLGZE0GQ1rf+Dsl+3SGMavwyN2Qc6xAre7IdzBGR3afHoPkci0Vu7bL6l5l/YJHceem65Qf/86Bn9bLnXz3sfG7Ha5JwujjA5VDPlGIeIxd1aDZ8djChZ4W5cRkUxqbq5kOwKucRghHTSyEORn6WDl7IFAukYH04a9TZqCqwQzrlVUsYnBgt3T8yh7ksJWKrfA7XuW+g62jBuwpIzIEsNe33qjDpL4vSPkFha7RNHqTmr/VP/95VfNWFK3dYUFAulXH6xqnCJUrGzP/9Z+jil0u6Tm/Gt2Zt0h5oJRzoEX26+Yccv9mkkemdLNeFhOTNAME+dAQxrSDxcCAwEAAQ==';

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function encodeBase64(value: ArrayBuffer | Uint8Array<ArrayBuffer>): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Matches the site's wire protocol, including same-key/IV response decryption. */
export async function createDuoEnvelope(payload: unknown, publicKey = DUO_PUBLIC_KEY) {
  const { subtle } = globalThis.crypto;
  const encoder = new TextEncoder();
  const aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const rsa = await subtle.importKey('spki', decodeBase64(publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const params = await subtle.encrypt({ name: 'AES-GCM', iv }, aes, encoder.encode(JSON.stringify(payload)));
  const rawKey = await subtle.exportKey('raw', aes);
  const key = await subtle.encrypt({ name: 'RSA-OAEP' }, rsa, encoder.encode(`${encodeBase64(rawKey)}|${encodeBase64(iv)}`));
  return {
    body: { params: encodeBase64(params), key: encodeBase64(key) },
    async decrypt(response: string): Promise<unknown> {
      const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv }, aes, decodeBase64(response));
      return JSON.parse(new TextDecoder().decode(plaintext));
    },
  };
}
