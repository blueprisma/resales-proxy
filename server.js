import express from 'express';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3000;

const RESALES_USER = process.env.RESALES_USER || 'RESALES@ININMO7';
const RESALES_PASS = process.env.RESALES_PASS || 'ZWO3WPZ7UU';

let cachedPropertiesMap = new Map();
let lastCachedTime = 0;
let isSyncing = false;
let hasPerformedCleanLoad = false;

let syncProgress = {
    inProgress: false,
    pagesFetched: 0,
    propertiesDownloadedThisCycle: 0,
    lastError: null
};

const CLEAN_LOAD_PAGE_SIZE = 50;  
const INCREMENTAL_PAGE_SIZE = 100; 
const MAX_PAGES_PER_SYNC = 400;   

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

app.use(express.json());

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getCleanTagValue(block, tag) {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const match = block.match(regex);
    if (!match) return '';
    const innerContent = match[1].trim();
    const esMatch = innerContent.match(/<es[^>]*>([\s\S]*?)<\/es>/i);
    if (esMatch) return esMatch[1].trim();
    if (innerContent.includes('<') && innerContent.includes('>')) {
        return innerContent.replace(/<[^>]*>/g, '').trim();
    }
    return innerContent;
}

function parseSingleProperty(block) {
    const propertyid = getCleanTagValue(block, 'id') || getCleanTagValue(block, 'Reference') || getCleanTagValue(block, 'PropertyRefNo') || '';
    if (!propertyid) return null;

    const title = getCleanTagValue(block, 'title') || getCleanTagValue(block, 'type') || `Propiedad Ref: ${propertyid}`;
    const location = getCleanTagValue(block, 'town') || getCleanTagValue(block, 'city') || getCleanTagValue(block, 'area') || getCleanTagValue(block, 'location') || 'Costa Blanca';
    const isNewDev = getCleanTagValue(block, 'newdevelopment') === '1' || getCleanTagValue(block, 'newdevelopment') === 'true' || getCleanTagValue(block, 'new_development') === '1';
    const marketType = isNewDev ? 'New Development' : 'Resale';
    const price = parseFloat(getCleanTagValue(block, 'price')) || 0;
    const beds = parseInt(getCleanTagValue(block, 'bedrooms')) || parseInt(getCleanTagValue(block, 'beds')) || 0;
    const baths = parseInt(getCleanTagValue(block, 'bathrooms')) || parseInt(getCleanTagValue(block, 'baths')) || 0;
    const sqm = parseFloat(getCleanTagValue(block, 'built')) || parseFloat(getCleanTagValue(block, 'built_size')) || parseFloat(getCleanTagValue(block, 'sqm')) || 0;
    const propertyType = getCleanTagValue(block, 'type') || 'Property';
    const description = getCleanTagValue(block, 'description') || getCleanTagValue(block, 'desc') || '';

    let uniqueUrls = [];
    const picturesMatch = block.match(/<(?:pictures|images|photos)[^>]*>([\s\S]*?)<\/(?:pictures|images|photos)>/i);
    const searchBlock = picturesMatch ? picturesMatch[1] : block;
    
    const urlTagMatches = searchBlock.match(/<url[^>]*>([^<]*)<\/url>/gi);
    if (urlTagMatches) {
        uniqueUrls = urlTagMatches.map(m => m.replace(/<\/?url[^>]*>/gi, '').trim()).filter(u => u.length > 0);
    } else {
        const rawUrlMatches = searchBlock.match(/https?:\/\/[^\s"<>]+\b/gi) || [];
        uniqueUrls = [...new Set(rawUrlMatches.map(u => u.trim()))];
    }

    uniqueUrls = uniqueUrls.map(u => u.replace(/&amp;/g, '&'));
    uniqueUrls = [...new Set(uniqueUrls)];

    const imagesStr = uniqueUrls.join(',');
    const mainimage = uniqueUrls.length > 0 ? uniqueUrls[0] : 'https://wixideas.wixsite.com/images/placeholder.png';

    return {
        _id: propertyid,
        title,
        location,
        marketType,
        price,
        beds,
        baths,
        sqm,
        propertyType,
        description,
        mainimage,
        propertyid,
        images: imagesStr
    };
}

function fetchXmlPage(isCleanLoadFirstCall, pageSize) {
    return new Promise((resolve, reject) => {
        let url = `https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=${encodeURIComponent(RESALES_USER)}&P=${encodeURIComponent(RESALES_PASS)}&FV=2&N=${pageSize}`;
        if (isCleanLoadFirstCall) {
            url += '&I=TRUE';
        }

        // Timeout extendido a 90 segundos para absorber la generación inicial de España
        const options = {
            timeout: 90000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
            }
        };

        const req = https.get(url, options, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Resales respondió HTTP ${res.statusCode}`));
            }

            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);

            res.on('end', () => {
                const lowerData = data.toLowerCase();
                if (lowerData.includes('previous instance') || lowerData.includes('please wait') || lowerData.includes('running')) {
                    return reject(new Error("RESALES_CONCURRENCY_LOCK"));
                }

                let startTag = '';
                let endTag = '';
                const tagMatch = data.match(/<(Property_Item|Property|property_item|property)>/i);
                if (tagMatch) {
                    startTag = tagMatch[0];
                    endTag = startTag.replace('<', '</');
                } else {
                    return resolve([]); 
                }

                const properties = [];
                const propertyBlocks = data.split(new RegExp(startTag, 'i'));
                propertyBlocks.shift();

                for (let block of propertyBlocks) {
                    const cleanBlock = block.split(new RegExp(endTag, 'i'))[0];
                    const parsed = parseSingleProperty(cleanBlock);
                    if (parsed) properties.push(parsed);
                }

                resolve(properties);
            });

            res.on('error', err => reject(err));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error("TIMEOUT_SINGLE_PAGE_90S"));
        });

        req.on('error', err => reject(err));
    });
}

async function fetchOnePageWithRetry(isCleanLoadFirstCall, pageSize) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            return await fetchXmlPage(isCleanLoadFirstCall, pageSize);
        } catch (err) {
            lastErr = err;
            console.warn(`[Proxy Worker] Intento ${attempt}/3 falló en micro-lote: ${err.message}`);
            if (err.message === "RESALES_CONCURRENCY_LOCK") throw err;
            if (attempt < 3) await wait(5000 * attempt);
        }
    }
    throw lastErr || new Error("ERROR_FETCHING_MICRO_BATCH");
}

async function runSyncCycle() {
    if (isSyncing) return;
    isSyncing = true;

    const isThisACleanLoad = !hasPerformedCleanLoad;
    const pageSize = isThisACleanLoad ? CLEAN_LOAD_PAGE_SIZE : INCREMENTAL_PAGE_SIZE;

    syncProgress = {
        inProgress: true,
        pagesFetched: 0,
        propertiesDownloadedThisCycle: 0,
        lastError: null
    };

    console.log(`[Proxy Worker] Iniciando descarga (${isThisACleanLoad ? 'Clean Load I=TRUE' : 'Incremental'}), lote size: ${pageSize}...`);

    try {
        let pageCount = 0;
        let totalReceived = 0;
        let keepFetching = true;

        while (keepFetching && pageCount < MAX_PAGES_PER_SYNC) {
            const isFirstCallOfClean = (isThisACleanLoad && pageCount === 0);

            const properties = await fetchOnePageWithRetry(isFirstCallOfClean, pageSize);
            pageCount++;
            syncProgress.pagesFetched = pageCount;

            if (properties.length === 0) {
                console.log(`[Proxy Worker] Micro-lote ${pageCount} devolvió 0 registros. Fin de catálogo.`);
                keepFetching = false;
                break;
            }

            for (const p of properties) {
                cachedPropertiesMap.set(p._id, p);
            }

            totalReceived += properties.length;
            syncProgress.propertiesDownloadedThisCycle = totalReceived;

            console.log(`[Proxy Worker] Lote ${pageCount}: +${properties.length} (Total acumulado en RAM: ${cachedPropertiesMap.size}).`);

            if (properties.length < pageSize) {
                keepFetching = false;
            } else {
                await wait(300); 
            }
        }

        if (isThisACleanLoad && totalReceived > 0) {
            hasPerformedCleanLoad = true;
        }

        if (cachedPropertiesMap.size > 0) {
            lastCachedTime = Date.now();
            syncProgress.lastError = "Sincronizado con éxito";
        }

    } catch (err) {
        console.warn("[Proxy Worker WARN] Excepción en ciclo:", err.message);
        syncProgress.lastError = err.message;
    } finally {
        isSyncing = false;
        syncProgress.inProgress = false;
    }
}

setInterval(() => {
    if (cachedPropertiesMap.size === 0 && !isSyncing) {
        runSyncCycle();
    }
}, 20000);

setTimeout(runSyncCycle, 3000);

app.get('/api/properties', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const allItems = Array.from(cachedPropertiesMap.values());

    if (allItems.length === 0) {
        if (!isSyncing) runSyncCycle();
        
        const noteMsg = syncProgress.inProgress 
            ? `Descargadas ${syncProgress.propertiesDownloadedThisCycle} propiedades de España (Micro-lote ${syncProgress.pagesFetched})...`
            : `Preparando carga inicial desde España. Estado: ${syncProgress.lastError || 'Iniciando...'}`;

        return res.status(200).json({
            status: "cooling_down",
            properties: [],
            total: 0,
            page,
            limit,
            hasMore: false,
            cachedAt: null,
            note: noteMsg
        });
    }

    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedItems = allItems.slice(startIndex, endIndex);

    res.json({
        status: "success",
        properties: paginatedItems,
        total: allItems.length,
        page,
        limit,
        hasMore: endIndex < allItems.length,
        cachedAt: new Date(lastCachedTime).toISOString(),
        note: "Datos servidos desde memoria RAM protegida."
    });
});

app.listen(PORT, () => {
    console.log(`[Proxy] Servidor listo en puerto ${PORT}`);
});
