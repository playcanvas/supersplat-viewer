interface AssetSource {
    filename?: string;
    url?: string;
    contents?: File;
    animationFrame?: boolean;                                   // animations disable morton re-ordering at load time for faster loading
    mapUrl?: (name: string) => string;                          // function to map texture names to URLs
    mapFile?: (name: string) => AssetSource | null;             // function to map names to files
}

const fetchRequest = async (assetSource: AssetSource) : Promise<Response | File | null> => {
    if (assetSource.contents) {
        return assetSource.contents;
    }
    return await fetch(assetSource.url || assetSource.filename);
};

const fetchArrayBuffer = async (assetSource: AssetSource) : Promise<ArrayBuffer> | null => {
    const response = await fetchRequest(assetSource);

    if (response instanceof Response) {
        if (!response.ok) {
            return null;
        }
        const buffer = await response.arrayBuffer();

        const firstBytes = new Uint8Array(buffer).subarray(0, Math.min(100, buffer.byteLength));
        const textDecoder = new TextDecoder('utf-8');
        const text = textDecoder.decode(firstBytes);
        if (text.trim().startsWith('<')) {
            // Likely HTML content
            console.warn(`fetchArrayBuffer: Received HTML instead of binary data for ${assetSource.url}`);
            return null;
        }
        return buffer;
    }

    if (response instanceof File) {
        return await response.arrayBuffer();
    }

    return response;
};

const fetchText = async (assetSource: AssetSource) : Promise<string> | null => {
    const response = await fetchRequest(assetSource);

    if (response instanceof Response) {
        if (!response.ok) {
            return null;
        }
        return await response.text();
    }

    if (response instanceof File) {
        return await response.text();
    }

    return response;
};

export type { AssetSource };

export { fetchArrayBuffer, fetchText };
