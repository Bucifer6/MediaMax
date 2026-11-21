import type { ImportConfig, ImportJob, ImportLibraryMapping, ImportOptions, ImportPathMapping, ImportPreview, ImportTestResult, User } from '@mediamax/shared';
import { connection as conn, type Conn, type MappedUser, mapFolders } from './import/common.js';
import { embyFolder, type EmbyFolder, type EmbyUser, mapEmbyUser } from './import/emby.js';
import * as imp from './import/index.js';

/**
 * The Emby importer's original entry points, now thin wrappers over the source-neutral importer in `./import/`
 * (Admin → Import from another server). Kept so older callers and the `/admin/emby-import/*` routes keep working.
 */

export { mapPath, safeUsername } from './import/common.js';
export { embyRating } from './import/emby.js';
export const LINK_PURPOSE = 'emby-import';

export const getImportConfig = (): ImportConfig => imp.getImportConfig('emby');
export const saveImportConfig = (patch: Partial<ImportConfig>, admin?: User): ImportConfig => imp.saveImportConfig('emby', patch, admin);
export const connection = (override: Partial<Pick<ImportConfig, 'url' | 'apiKey'>> = {}): Conn => conn('emby', override);
export const testConnection = (override: Partial<Pick<ImportConfig, 'url' | 'apiKey'>> = {}): Promise<ImportTestResult> => imp.testConnection('emby', override);
export const previewImport = (o: ImportOptions = {}, quick = false): Promise<ImportPreview> => imp.previewImport('emby', o, quick);
export const startImport = (admin: User, options: ImportOptions, origin: string): ImportJob => imp.startImport('emby', admin, options, origin);
export const getJob = (): ImportJob | null => imp.getJob();

export const mapLibraries = (folders: EmbyFolder[], mappings: ImportPathMapping[]): ImportLibraryMapping[] => mapFolders(folders.map(embyFolder), mappings);
export const mapUser = (u: EmbyUser, folders: EmbyFolder[], libs: ImportLibraryMapping[]): MappedUser => mapEmbyUser('emby', u, folders.map(embyFolder), libs);
