/** The Ant mark: an amber hexagon carrying a three-segment ant. Same geometry as public/favicon.svg. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <polygon points="32,9 51.92,20.5 51.92,43.5 32,55 12.08,43.5 12.08,20.5" fill="var(--ant-accent)" />
      <g fill="var(--ant-bg)">
        <ellipse cx="32" cy="21.1" rx="3.5" ry="3.2" />
        <ellipse cx="32" cy="28.8" rx="2.9" ry="3.8" />
        <ellipse cx="32" cy="39.7" rx="5.4" ry="7" />
      </g>
    </svg>
  );
}
