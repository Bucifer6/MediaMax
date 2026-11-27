/**
 * `p`'s result, or `fallback` when it takes longer than `ms`. For filesystem calls on network shares: Windows waits on
 * an SMB share whose PC is asleep for a minute or more, and the caller would rather report it offline. The call itself
 * carries on in the background (a libuv thread stays busy with it until the OS gives up).
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(fallback);
    }, ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}
