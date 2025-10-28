import type { AppBase, Asset } from 'playcanvas';
import { GSplatResource } from 'playcanvas';

import { AssetSource } from '../loaders/asset-source';
import { loadLcc } from '../loaders/lcc';

class LccParser {
    app: AppBase;

    maxRetries: number;

    /**
     * @param {AppBase} app - The app instance.
     * @param {number} maxRetries - Maximum amount of retries.
     */
    constructor(app: AppBase, maxRetries: number) {
        this.app = app;
        this.maxRetries = maxRetries;
    }

    /**
     * Create AssetSource from asset and url
     * @param asset - The asset to create the AssetSource from.
     * @param url - The URL to create the AssetSource from.
     * @param url.load - The load URL.
     * @param url.original - The original URL.
     * @returns The AssetSource.
     */
    private createAssetSource(asset: any, url: { load: string; original?: string }): AssetSource {
        // Get base URL
        const baseUrl = url.load || asset.file?.url || asset.url;

        return {
            url: baseUrl,
            mapFile: (filename: string): AssetSource | null => {
                // Check if asset has a mapFile in its data - this handles files from zip, etc.
                const mapFile = (asset.data as any)?.mapFile;

                if (mapFile) {
                    const file = mapFile(filename);
                    if (file) {
                        // If it's an optional file and the file from mapFile returns something,
                        // we still use it - the file might exist in the zip
                        return file;
                    }
                }

                // Otherwise, construct URL from base URL for required files
                if (baseUrl) {
                    const fullUrl = new URL(filename, new URL(baseUrl, window.location.href).toString()).toString();
                    return {
                        url: fullUrl
                    };
                }

                return null;
            },
            mapUrl: (name: string): string => {
                const mapUrl = (asset.data as any)?.mapUrl;
                if (mapUrl) {
                    return mapUrl(name);
                }

                if (baseUrl) {
                    return new URL(name, new URL(baseUrl, window.location.href).toString()).toString();
                }

                return name;
            }
        };
    }

    private loading = false;

    /**
     * Mock progress for the asset.
     * @param {Asset} asset - The asset to mock progress for.
     */
    private mockProgress(asset: Asset) {
        if (!asset || this.loading) return;
        this.loading = true;
        let progress = 0;

        const timer = setInterval(() => {
            if (!this.loading || progress >= 100) {
                clearInterval(timer);
                return;
            }

            if (asset) {
                asset.fire('progress', progress, 100);
            }

            progress++;
        }, 50);
    }

    /**
     * @param {object} url - The URL of the resource to load.
     * @param {string} url.load - The URL to use for loading the resource.
     * @param {string} url.original - The original URL useful for identifying the resource type.
     * @param {ResourceHandlerCallback} callback - The callback used when
     * the resource is loaded or an error occurs.
     * @param {Asset} asset - Container asset.
     */
    async load(
        url: { load: string; original?: string } | string,
        callback: (err: any, data?: any) => void,
        asset: Asset
    ) {
        try {
            // Normalize url
            const normalizedUrl: { load: string; original?: string } =
                typeof url === 'string' ? { load: url, original: url } : url;

            // Create AssetSource
            const assetSource = this.createAssetSource(asset, normalizedUrl);

            // Mock progress during loading
            this.mockProgress(asset);

            // Load LCC data
            const data = await loadLcc(assetSource);
            this.loading = false;

            // Report completion
            if (asset) {
                asset.fire('progress', 100, 100);
                // allow application to process the data
                asset.fire('load:data', data);
            }

            // Check if app is available and graphics device exists
            if (!this.app?.graphicsDevice || this.app?.graphicsDevice?._destroyed) {
                callback('Graphics device is not available', null);
                return;
            }

            // Construct the resource
            const resource = new GSplatResource(this.app.graphicsDevice, data);
            callback(null, resource);
        } catch (err) {
            callback(err, null);
        }
    }

    /**
     * @param {string} url - The URL.
     * @param {any} data - The data.
     * @returns Return the data.
     */
    open(url: string, data: any) {
        return data;
    }
}

export { LccParser };
