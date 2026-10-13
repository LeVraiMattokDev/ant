import type { FeatureModule } from '../types';

/**
 * Feature module « Notifications et suivi » of the web app: vue Suivi, lu/non-lu partagé, présence, rappels.
 * Slots: see FeatureModule (../types.ts). Ownership and contract: docs/ARCHITECTURE.md « Évolutions », docs/API.md.
 */
export const trackingFeature: FeatureModule = {
  name: 'tracking',
};
