import { useMemo } from 'react';
import { encodeQr } from '../utils/qrcode';

/** QR code as an SVG. Always dark on white so phone cameras read it in any theme. */
export function QrCode({ value, size = 200, label = 'QR code' }: { value: string; size?: number; label?: string }) {
  const { path, dim } = useMemo(() => {
    const m = encodeQr(value, 'M');
    const q = 4;
    let d = '';
    m.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) d += `M${x + q} ${y + q}h1v1h-1z`;
    }));
    return { path: d, dim: m.length + q * 2 };
  }, [value]);
  return (
    <svg className="qr-code" width={size} height={size} viewBox={`0 0 ${dim} ${dim}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={dim} height={dim} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
