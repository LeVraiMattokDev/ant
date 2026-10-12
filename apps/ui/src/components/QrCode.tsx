import { useMemo } from 'react';
import QRCode from 'qrcode';

/** QR code rendered as inline SVG (no data: URL, so it works under a strict CSP). */
export function QrCode({ text, size = 184, label }: { text: string; size?: number; label: string }) {
  const { path, n } = useMemo(() => {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const count = modules.size;
    let d = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (modules.get(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
      }
    }
    return { path: d, n: count + 8 };
  }, [text]);
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className="rounded-[4px]">
      <rect width={n} height={n} fill="#ffffff" />
      <path d={path} fill="#111111" />
    </svg>
  );
}
