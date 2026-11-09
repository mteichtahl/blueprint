/**
 * WebAuthn in the browser, for Cognito's passkey sign-in and registration.
 * Cognito sends and expects the W3C JSON forms (base64url binary fields).
 */

export const passkeysSupported = () =>
  typeof window !== 'undefined' &&
  typeof window.PublicKeyCredential === 'function' &&
  !!navigator.credentials;

export function fromB64url(s: string): ArrayBuffer {
  const b64 = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function toB64url(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    buf instanceof ArrayBuffer
      ? new Uint8Array(buf)
      : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type Json = Record<string, unknown>;
const creds = (list: unknown) =>
  ((list as Json[] | undefined) ?? []).map((c) => ({ ...c, id: fromB64url(c.id as string) }));

export function requestOptions(json: Json): PublicKeyCredentialRequestOptions {
  return {
    ...(json as object),
    challenge: fromB64url(json.challenge as string),
    allowCredentials: creds(json.allowCredentials),
  } as PublicKeyCredentialRequestOptions;
}

export function creationOptions(json: Json): PublicKeyCredentialCreationOptions {
  const user = json.user as Json;
  return {
    ...(json as object),
    challenge: fromB64url(json.challenge as string),
    user: { ...user, id: fromB64url(user.id as string) },
    excludeCredentials: creds(json.excludeCredentials),
  } as PublicKeyCredentialCreationOptions;
}

/** A credential in its JSON form (PublicKeyCredential.toJSON, with a fallback). */
export function credentialJson(cred: PublicKeyCredential): Json {
  const withJson = cred as PublicKeyCredential & { toJSON?: () => Json };
  if (typeof withJson.toJSON === 'function') return withJson.toJSON();
  const r = cred.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse;
  const response: Json = { clientDataJSON: toB64url(r.clientDataJSON) };
  if ('attestationObject' in r && r.attestationObject) {
    response.attestationObject = toB64url(r.attestationObject);
    response.transports = r.getTransports?.() ?? [];
  }
  if ('authenticatorData' in r && r.authenticatorData) {
    response.authenticatorData = toB64url(r.authenticatorData);
    response.signature = toB64url(r.signature);
    if (r.userHandle) response.userHandle = toB64url(r.userHandle);
  }
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    response,
    clientExtensionResults: cred.getClientExtensionResults(),
    ...(cred.authenticatorAttachment
      ? { authenticatorAttachment: cred.authenticatorAttachment }
      : {}),
  };
}

/** Sign in: ask the device for a passkey assertion. */
export async function getPasskey(optionsJson: string): Promise<Json> {
  const cred = (await navigator.credentials.get({
    publicKey: requestOptions(JSON.parse(optionsJson) as Json),
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was chosen.');
  return credentialJson(cred);
}

/** Register: create a passkey on this device. */
export async function createPasskey(options: Json): Promise<Json> {
  const cred = (await navigator.credentials.create({
    publicKey: creationOptions(options),
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was created.');
  return credentialJson(cred);
}

/** The browser's "user cancelled / timed out" errors, which aren't failures worth alarming over. */
export const cancelled = (e: unknown) =>
  e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError');
