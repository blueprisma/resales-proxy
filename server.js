import express from 'express';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3000;

const RESALES_USER = process.env.RESALES_USER || 'RESALES@ININMO7';
const RESALES_PASS = process.env.RESALES_PASS || 'ZWO3WPZ7UU';

let cachedPropertiesMap = new Map();
let lastCachedTime = 0;
let isSyncing = false;
let lastSyncStatusMessage = "Iniciando carga limpia...";
let cooldownUntil = 0;

const PAGE_SIZE = 500;

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

app.use(express.json());

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

function fetchXmlPage(isCleanLoadFirstCall) {
    return new Promise((resolve, reject) => {
        let url = `https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=${encodeURIComponent(RESALES_USER)}&P=${encodeURIComponent(RESALES_PASS)}&FV=2&N=${PAGE_SIZE}`;
        if (isCleanLoadFirstCall) {
            url += '&I=TRUE';
        }

        const options = {
            timeout: 60000,
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
            reject(new Error("TIMEOUT_CONNECTING_TO_RESALES"));
        });

        req.on('error', err => reject(err));
    });
}

async function runSyncCycle() {
    if (isSyncing) return;
    if (Date.now() < cooldownUntil) {
        console.log(`[Proxy Worker] Enfriamiento activo. Esperando a que España termine su proceso.`);
        return;
    }

    isSyncing = true;
    console.log("[Proxy Worker] Iniciando ciclo de descarga en segundo plano desde España...");

    try {
        let pageCount = 0;
        let keepFetching = true;

        while (keepFetching && pageCount < 30) {
            const isFirstCall = (pageCount === 0 && cachedPropertiesMap.size === 0);
            
            console.log(`[Proxy Worker] Solicitando lote ${pageCount + 1} (${isFirstCall ? 'Clean Load I=TRUE' : 'N=500'})...`);
            
            const properties = await fetchXmlPage(isFirstCall);
            pageCount++;

            if (properties.length === 0) {
                console.log(`[Proxy Worker] Lote ${pageCount} devolvió 0 propiedades. Fin de la descarga.`);
                keepFetching = false;
                break;
            }

            for (const p of properties) {
                cachedPropertiesMap.set(p._id, p);
            }

            console.log(`[Proxy Worker] Lote ${pageCount} recibido: ${properties.length} propiedades (Total en RAM: ${cachedPropertiesMap.size}).`);

            if (properties.length < PAGE_SIZE) {
                keepFetching = false;
            }
        }

        if (cachedPropertiesMap.size > 0) {
            lastCachedTime = Date.now();
            lastSyncStatusMessage = "Sincronización exitosa completa.";
        } else {
            lastSyncStatusMessage = "España devolvió 0 propiedades.";
        }

    } catch (err) {
        console.warn("[Proxy Worker WARN] Fallo en ciclo:", err.message);
        lastSyncStatusMessage = err.message;

        if (err.message === "RESALES_CONCURRENCY_LOCK") {
            cooldownUntil = Date.now() + (3 * 60 * 1000);
            lastSyncStatusMessage = "España está generando el paquete XML en su servidor. Enfriamiento de 3 minutos activado en Render.";
        }
    } finally {
        isSyncing = false;
    }
}

// Bucle en segundo plano cada 40 segundos (no afectado por peticiones HTTP)
setInterval(() => {
    if (cachedPropertiesMap.size === 0 && !isSyncing) {
        runSyncCycle();
    }
}, 40000);

// Disparo inicial a los 3 segundos
setTimeout(runSyncCycle, 3000);

app.get('/api/properties', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const allItems = Array.from(cachedPropertiesMap.values());

    if (allItems.length === 0) {
        return res.status(200).json({
            status: "cooling_down",
            properties: [],
            total: 0,
            page,
            limit,
            hasMore: false,
            cachedAt: null,
            note: `Procesando en segundo plano en Render. Estado actual: ${lastSyncStatusMessage}`
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
        note: "Servido desde memoria RAM protegida."
    });
});

app.listen(PORT, () => {
    console.log(`[Proxy] Servidor listo en puerto ${PORT}`);
});
