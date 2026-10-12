/**
 * Generated bot avatars: a friendly geometric creature whose shape, colour and eyes
 * are derived deterministically from the bot slug (same slug → same creature everywhere).
 */

/** Default avatar given by the server to a new bot; it means "no custom emoji". */
export const DEFAULT_AVATAR_EMOJI = '🐜';

export const AVATAR_SHAPES = ['circle', 'rounded', 'hexagon', 'triangle', 'blob', 'diamond'] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];

/** Vivid but calm hues, distinct from one another; each keeps the white eyes readable. */
export const AVATAR_COLORS = [
  '#2ebd9b', // teal
  '#f2b632', // honey
  '#8b6cf0', // violet
  '#ec5a93', // pink
  '#3d8ef0', // blue
  '#f17a3c', // orange
  '#49b45c', // green
  '#22b2d0', // cyan
] as const;

export type EyeStyle = 'pill' | 'dot' | 'wide';

export interface AvatarSpec {
  shape: AvatarShape;
  color: string;
  eyes: EyeStyle;
  /** Horizontal gap between the eyes, in viewBox units (out of 40). */
  eyeGap: number;
  /** Vertical offset of the eyes from the shape's optical centre, in viewBox units. */
  eyeShift: number;
}

/** FNV-1a 32-bit, stable across platforms. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3 finaliser: spreads FNV's weak low bits so every field below is well distributed. */
function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const EYES: readonly EyeStyle[] = ['pill', 'dot', 'wide'];

export function avatarSpec(seed: string): AvatarSpec {
  const h = mix(hashString(seed || '?'));
  const h2 = mix(hashString(`${seed}·eyes`));
  return {
    shape: AVATAR_SHAPES[h % AVATAR_SHAPES.length]!,
    color: AVATAR_COLORS[Math.floor(h / AVATAR_SHAPES.length) % AVATAR_COLORS.length]!,
    eyes: EYES[h2 % EYES.length]!,
    eyeGap: 7 + (h2 >>> 4) % 4,
    eyeShift: ((h2 >>> 9) % 3) - 1,
  };
}

/** True when the owner picked an emoji avatar (anything but the default ant). */
export function hasCustomEmoji(avatar: string | null | undefined): boolean {
  const a = (avatar ?? '').trim();
  return a.length > 0 && a !== DEFAULT_AVATAR_EMOJI;
}
