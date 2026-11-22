/** Pure helpers of the separation process (child.ts), kept apart so tests can import them without its IPC handlers. */

/**
 * Sanity check of one separated chunk: HT-Demucs's sources add up to the input mix, so a chunk whose sources don't
 * (non-finite values, or a residual above half the mix's energy) is broken output. Some GPU drivers run the graph
 * without an error but return noise; this catches that so the track is redone on the CPU.
 * mix: [2, n] planar; out: [sources, 2, n] planar.
 */
export function chunkLooksValid(mix: ArrayLike<number>, out: ArrayLike<number>, sources: number): boolean {
  const len = mix.length;
  let e = 0, r = 0;
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let k = 0; k < sources; k++) s += out[k * len + i];
    if (!Number.isFinite(s)) return false;
    const d = s - mix[i];
    e += mix[i] * mix[i];
    r += d * d;
  }
  return r <= 0.5 * e + 1e-3 * len;
}

/** GPU execution providers worth trying on this platform, in order. */
export function gpuProviders(platform: string = process.platform, supported: { name: string }[] = []): string[] {
  const has = (n: string) => supported.some((b) => b.name === n);
  if (platform === 'win32') return has('dml') ? ['dml'] : [];
  if (platform === 'darwin') return has('coreml') ? ['coreml'] : [];
  if (platform === 'linux') return has('cuda') ? ['cuda'] : [];
  return [];
}
