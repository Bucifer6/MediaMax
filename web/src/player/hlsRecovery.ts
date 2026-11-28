/** Bounded application recovery after hls.js exhausts its own request retries. */
export function hlsRecovery(actions: {
  media: () => void;
  network: () => void;
  fatal: (message: string) => void;
}) {
  let recovered = 0;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    error(type: string, message: string) {
      if (ended) return;
      // Duplicate errors while waiting must not schedule extra loads or consume the retry budget.
      if (type === 'networkError' && timer !== undefined) return;
      cancel();
      if (type === 'mediaError' && recovered < 2) {
        recovered++;
        actions.media();
      } else if (type === 'networkError' && recovered < 3) {
        recovered++;
        timer = setTimeout(() => {
          timer = undefined;
          if (!ended) actions.network();
        }, 1000 * recovered);
      } else {
        ended = true;
        actions.fatal(message);
      }
    },
    destroy() {
      ended = true;
      cancel();
    },
  };
}
