import { type AppBase, Asset } from 'playcanvas';
import { Entity } from 'playcanvas';

import { LccParser } from './parsers/lcc-parser';

// Asset loader interface for different content types
interface AssetLoader {
    canHandle(url: string, contents?: any): boolean;
    load(app: AppBase, url: string, contents?: any): Asset;
}

// LCC loader
class LccLoader implements AssetLoader {
    private lccParser: LccParser;

    constructor(app: AppBase) {
        this.lccParser = new LccParser(app, 3);
    }

    canHandle(url: string, contents?: any): boolean {
        return url.endsWith('.lcc') || url.includes('meta.lcc') || contents?.type === 'lcc';
    }

    load(app: AppBase, url: string, contents?: any): Asset {
        const filename = new URL(url, location.href).pathname.split('/').pop() || 'meta.lcc';

        const asset = new Asset(filename, 'gsplat', {
            url,
            filename,
            contents
        });

        app.assets.add(asset);

        // Use LccParser to load the asset manually
        this.lccParser.load(
            url,
            (err, data) => {
                if (err) {
                    asset.fire('error', err);
                } else {
                    asset.resource = data;
                    asset.fire('load');
                }
            },
            asset
        );

        return asset;
    }
}

// Default loader for unknown types
class DefaultLoader implements AssetLoader {
    canHandle(url: string, contents?: any): boolean {
        return true; // Always handles as fallback
    }

    load(app: AppBase, url: string, contents?: any): Asset {
        const filename = new URL(url, location.href).pathname.split('/').pop();

        const asset = new Asset(filename, 'gsplat', {
            url,
            filename,
            contents
        });

        app.assets.add(asset);
        app.assets.load(asset);

        return asset;
    }
}

export const loadContent = (app: AppBase) => {
    const { contentUrl, contents } = window.sse;

    if (!contentUrl) {
        console.error('No content URL provided');
        return;
    }

    // Create loaders with app instance
    const assetLoaders: AssetLoader[] = [
        new LccLoader(app),
        new DefaultLoader() // Must be last as fallback
    ];

    // Find appropriate loader
    const loader = assetLoaders.find(loader => loader.canHandle(contentUrl, contents));
    const asset = loader.load(app, contentUrl, contents);

    asset.on('load', () => {
        // Create entity and add gsplat component
        const entity = new Entity('gsplat');
        entity.setLocalEulerAngles(0, 0, 180);
        entity.addComponent('gsplat', { asset });
        app.root.addChild(entity);
    });
};
