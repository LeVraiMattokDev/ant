import { memo } from 'react';
import type { BotDTO } from '@ant/shared';
import { avatarSpec, hasCustomEmoji, type AvatarShape, type AvatarSpec } from '../lib/avatar';
import { cx } from './ui';

export type AvatarBot = Pick<BotDTO, 'slug' | 'avatar' | 'name'>;

/** Rounded polygons are drawn with a thick stroke of the fill colour, which rounds their corners. */
function Shape({ shape, color }: { shape: AvatarShape; color: string }) {
  const round = { fill: color, stroke: color, strokeLinejoin: 'round' as const };
  switch (shape) {
    case 'circle':
      return <circle cx="20" cy="20" r="18" fill={color} />;
    case 'rounded':
      return <rect x="3" y="3" width="34" height="34" rx="11" fill={color} />;
    case 'hexagon':
      return <polygon points="5,20 12,7.5 28,7.5 35,20 28,32.5 12,32.5" strokeWidth="5" {...round} />;
    case 'triangle':
      return <polygon points="20,6.5 35,32 5,32" strokeWidth="6" {...round} />;
    case 'diamond':
      return <polygon points="20,4 36,20 20,36 4,20" strokeWidth="5" {...round} />;
    case 'blob':
      return <path d="M20.5 3.2c9.6 0 16.6 6.6 16.3 16.4-.3 10.3-7.5 17.2-17.2 17.2C9.8 36.8 3.2 30.3 3.2 20.8 3.2 10.6 10.4 3.2 20.5 3.2Z" fill={color} />;
  }
}

/** Optical centre of each shape (the triangle's mass sits low). */
const CENTRE_Y: Record<AvatarShape, number> = { circle: 20, rounded: 20, hexagon: 20, triangle: 24.5, diamond: 20, blob: 20 };

function Eyes({ spec }: { spec: AvatarSpec }) {
  const narrow = spec.shape === 'triangle' || spec.shape === 'diamond';
  const gap = narrow ? Math.min(spec.eyeGap, 7) : spec.eyeGap;
  const cy = CENTRE_Y[spec.shape] + spec.eyeShift;
  const xs = [20 - gap / 2, 20 + gap / 2];
  return (
    <g fill="#fff" fillOpacity="0.96">
      {xs.map((x) =>
        spec.eyes === 'dot' ? (
          <circle key={x} cx={x} cy={cy} r="2.1" />
        ) : spec.eyes === 'wide' ? (
          <rect key={x} x={x - 2.5} y={cy - 1.7} width="5" height="3.4" rx="1.7" />
        ) : (
          <rect key={x} x={x - 1.8} y={cy - 3} width="3.6" height="6" rx="1.8" />
        ),
      )}
    </g>
  );
}

export const BotAvatar = memo(function BotAvatar({
  bot,
  size = 32,
  className,
  label,
}: {
  bot: AvatarBot | null | undefined;
  size?: number;
  className?: string;
  /** Accessible name; omit when the bot name is already written next to the avatar. */
  label?: string;
}) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
  if (!bot) {
    return (
      <svg viewBox="0 0 40 40" width={size} height={size} className={cx('shrink-0', className)} {...a11y}>
        <circle cx="20" cy="20" r="18" fill="var(--ant-active)" />
        <text x="20" y="21" textAnchor="middle" dominantBaseline="central" fontSize="17" fontWeight="600" fill="var(--ant-muted)">
          ?
        </text>
      </svg>
    );
  }
  const spec = avatarSpec(bot.slug || bot.name);
  const emoji = hasCustomEmoji(bot.avatar) ? bot.avatar.trim() : null;
  const cy = CENTRE_Y[spec.shape];
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} className={cx('shrink-0', className)} data-shape={spec.shape} {...a11y}>
      <Shape shape={spec.shape} color={spec.color} />
      {emoji ? (
        <text x="20" y={cy + 1} textAnchor="middle" dominantBaseline="central" fontSize={spec.shape === 'triangle' ? 13 : 18}>
          {emoji}
        </text>
      ) : (
        <Eyes spec={spec} />
      )}
    </svg>
  );
});

/** The owner ("Toi"). */
export function OwnerAvatar({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.34)) }}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#5b5b5b] to-[#3a3a3a] font-semibold text-white',
        className,
      )}
    >
      Toi
    </span>
  );
}

/** Up to three overlapping mini avatars and a "+N" counter, for group channels. */
export function GroupAvatar({ bots, size = 44, className }: { bots: AvatarBot[]; size?: number; className?: string }) {
  const mini = Math.round(size * 0.5);
  const shown = bots.length > 4 ? bots.slice(0, 3) : bots.slice(0, 4);
  const extra = bots.length - shown.length;
  const cells: ({ bot: AvatarBot } | { extra: number })[] = shown.map((bot) => ({ bot }));
  if (extra > 0) cells.push({ extra });

  if (cells.length <= 1) {
    return (
      <span className={cx('inline-flex items-center justify-center', className)} style={{ width: size, height: size }} aria-hidden="true">
        <BotAvatar bot={shown[0]} size={Math.round(size * 0.8)} />
      </span>
    );
  }
  if (cells.length === 2) {
    return (
      <span className={cx('relative inline-block shrink-0', className)} style={{ width: size, height: size }} aria-hidden="true">
        <BotAvatar bot={shown[0]} size={Math.round(size * 0.62)} className="absolute top-0 left-0" />
        <BotAvatar
          bot={shown[1]}
          size={Math.round(size * 0.62)}
          className="absolute right-0 bottom-0 rounded-full ring-2 ring-[var(--avatar-ring,var(--ant-surface))]"
        />
      </span>
    );
  }
  return (
    <span className={cx('grid shrink-0 grid-cols-2 place-items-center', className)} style={{ width: size, height: size }} aria-hidden="true">
      {cells.map((c, i) =>
        'bot' in c ? (
          <BotAvatar key={i} bot={c.bot} size={mini - 1} />
        ) : (
          <span key="extra" className="text-[11px] font-semibold text-fg" style={{ lineHeight: `${mini}px` }}>
            +{c.extra}
          </span>
        ),
      )}
    </span>
  );
}
