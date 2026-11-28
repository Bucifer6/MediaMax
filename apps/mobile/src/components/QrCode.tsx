/**
 * QR code drawn with plain Views (no SVG dependency): one View per horizontal run of dark modules. Always dark on
 * white with a 4-module quiet zone, so phone cameras read it on any theme.
 */
import { memo, useMemo } from 'react';
import { View } from 'react-native';
import { encodeQr } from '@/utils/qrcode';

export const QrCode = memo(function QrCode({ value, size }: { value: string; size: number }) {
  const { runs, dim } = useMemo(() => {
    const m = encodeQr(value, 'M');
    const out: { x: number; y: number; w: number }[] = [];
    m.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        if (!row[x]) {
          x++;
          continue;
        }
        const start = x;
        while (x < row.length && row[x]) x++;
        out.push({ x: start, y, w: x - start });
      }
    });
    return { runs: out, dim: m.length + 8 };
  }, [value]);
  const cell = size / dim;
  return (
    <View style={{ width: size, height: size, backgroundColor: '#fff' }} accessibilityRole="image" accessibilityLabel="Pairing QR code">
      {runs.map((r, i) => (
        <View key={i} style={{ position: 'absolute', left: (r.x + 4) * cell, top: (r.y + 4) * cell, width: r.w * cell + 0.5, height: cell + 0.5, backgroundColor: '#000' }} />
      ))}
    </View>
  );
});
