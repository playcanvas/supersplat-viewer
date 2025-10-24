import { ExperienceSettings as V1, migrate as migrateV1 } from './v1';
import { ExperienceSettings as V2, migrate as migrateV2 } from './v2';

const importSettings = (settings: any): V2 => {
    let result: V2;

    const version = settings.version;
    if (version === undefined) {
        // v1 -> v2
        result = migrateV2(migrateV1(settings as V1));
    } else if (version === 2) {
        // already v2
        result = settings as V2;
    } else {
        throw new Error(`Unsupported experience settings version: ${version}`);
    }

    return result;
};

export { importSettings };
