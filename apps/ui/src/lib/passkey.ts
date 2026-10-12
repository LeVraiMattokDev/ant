import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { PasskeyDTO } from '@ant/shared';
import { post } from './api';

export const passkeysSupported = (): boolean => typeof window !== 'undefined' && browserSupportsWebAuthn();

function friendly(err: unknown): Error {
  if (err instanceof WebAuthnError || (err instanceof Error && err.name === 'NotAllowedError')) {
    return new Error('Opération annulée ou refusée par l’appareil.');
  }
  return err instanceof Error ? err : new Error('Échec de la passkey.');
}

export async function loginWithPasskey(): Promise<void> {
  const optionsJSON = await post<PublicKeyCredentialRequestOptionsJSON>('/api/auth/passkey/login/options');
  let response;
  try {
    response = await startAuthentication({ optionsJSON });
  } catch (err) {
    throw friendly(err);
  }
  await post('/api/auth/passkey/login/verify', { response });
}

export async function registerPasskey(name: string): Promise<PasskeyDTO> {
  const optionsJSON = await post<PublicKeyCredentialCreationOptionsJSON>('/api/auth/passkey/register/options');
  let response;
  try {
    response = await startRegistration({ optionsJSON });
  } catch (err) {
    throw friendly(err);
  }
  return post<PasskeyDTO>('/api/auth/passkey/register/verify', { response, name });
}

export function defaultPasskeyName(): string {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Appareil';
  return `${device} — ${new Date().toLocaleDateString('fr-CH')}`;
}
