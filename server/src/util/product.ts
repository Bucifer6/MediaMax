/** Default product name (servers can be renamed in the Branding Studio). Mirrors @mediamax/shared. */
export const PRODUCT_NAME = 'Kinora';
/** The former product name: a server name still equal to it is the stock name, shown as PRODUCT_NAME. */
export const LEGACY_PRODUCT_NAME = 'MediaMax';

/** Map the legacy stock name to the current one; any other (white-label) name is returned unchanged. */
export function productName(name: string | null | undefined): string {
  return !name || name === LEGACY_PRODUCT_NAME ? PRODUCT_NAME : name;
}
