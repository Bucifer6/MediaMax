import { config } from '../config.js';
import { PRODUCT_NAME } from './product.js';

/** Public HTTP/discovery identity. Persisted provider-specific overrides still take precedence. */
export const USER_AGENT = `${PRODUCT_NAME}/${config.version}`;
