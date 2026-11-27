import fs from 'node:fs';

/**
 * Whether a file exists, without blocking. Media and artwork usually live on another PC or a NAS (\server\share):
 * a synchronous check there holds the whole server — every request, stream and the health check — until Windows
 * gives up on a sleeping or slow share, which can take minutes.
 */
export const fileExists = (p: string): Promise<boolean> => fs.promises.access(p).then(() => true, () => false);
