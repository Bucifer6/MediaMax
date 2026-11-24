/** Default product name (servers can be renamed in the Branding Studio). Mirrors @mediamax/shared. */
export const PRODUCT_NAME = 'Vibe';
/** The most recent former product name. */
export const LEGACY_PRODUCT_NAME = 'Kinora';
/** Every former product name: a server name still equal to one of them is the stock name, shown as PRODUCT_NAME. */
export const LEGACY_PRODUCT_NAMES: readonly string[] = ['Kinora', 'MediaMax'];

/** Map a former stock name to the current one; any other (white-label) name is returned unchanged. */
export function productName(name: string | null | undefined): string {
  return !name || LEGACY_PRODUCT_NAMES.includes(name) ? PRODUCT_NAME : name;
}
