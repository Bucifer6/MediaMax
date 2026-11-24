/** Default product name; mirrors PRODUCT_NAME in @mediamax/shared (kept local so the web bundle needs no runtime import from shared). */
export const PRODUCT_NAME = 'Vibe';
/** The most recent former product name. */
export const LEGACY_PRODUCT_NAME = 'Kinora';
/** A server still called by a former product name (Kinora, earlier MediaMax) counts as using the stock name. */
export const LEGACY_PRODUCT_NAMES: readonly string[] = ['Kinora', 'MediaMax'];
