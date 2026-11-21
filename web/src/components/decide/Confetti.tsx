import { useEffect, useRef } from 'react';

/**
 * Lightweight canvas confetti burst (no dependencies). Colours come from the theme (primary / accent / success /
 * warning). Honours prefers-reduced-motion by drawing nothing. Re-fires whenever `fireKey` changes.
 */
export function Confetti({ fireKey, duration = 2600, count = 140 }: { fireKey: string | number | null; duration?: number; count?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || fireKey == null) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const colors = ['--c-primary', '--c-accent', '--c-success', '--c-warning', '--c-danger']
      .map((v) => css.getPropertyValue(v).trim())
      .filter(Boolean);
    if (!colors.length) colors.push('#e5a00d', '#5b8cff', '#2fbf71');
    const parts = Array.from({ length: count }, (_, i) => {
      const side = i % 2 ? 1 : -1;
      const angle = (-Math.PI / 2) + side * (0.25 + Math.random() * 0.55);
      const speed = 7 + Math.random() * 9;
      return {
        x: w / 2 + side * w * 0.18, y: h * 0.62,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        size: 6 + Math.random() * 7, color: colors[i % colors.length], shape: i % 3,
      };
    });
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const el = t - start;
      ctx.clearRect(0, 0, w, h);
      const alpha = Math.max(0, 1 - Math.max(0, el - duration * 0.6) / (duration * 0.4));
      for (const p of parts) {
        p.vy += 0.28;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.shape === 0) ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        else if (p.shape === 1) {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 3, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(0, -p.size / 2);
          ctx.lineTo(p.size / 2, p.size / 2);
          ctx.lineTo(-p.size / 2, p.size / 2);
          ctx.fill();
        }
        ctx.restore();
      }
      if (el < duration) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, w, h);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fireKey, duration, count]);
  return <canvas ref={ref} className="confetti-canvas" aria-hidden="true" />;
}
