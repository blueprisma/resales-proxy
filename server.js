import express from 'express';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3000;

let cachedProperties = null;
let lastCachedTime = 0;
let isFetching = false;
let lastFetchAttempt = 0;

// Si la RAM está vacía, reintenta cada 2 minutos. Si ya tiene datos, mantiene 4 horas.
const EMPTY_RETRY_COOLDOWN_MS = 2 * 60 * 1000; 
const CACHE_DURATION = 4 * 60 * 60 * 1000;

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

async function fetchAndParseXml() {
    if (isFetching) throw new Error("FETCH_ALREADY_IN_PROGRESS");
    isFetching = true;
    lastFetchAttempt = Date.now();

    return new Promise((resolve, reject) => {
        const url = "https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2&P_Inc=0";
        
        const req = https.get(url, { timeout: 35000 }, (res) => {
            if (res.statusCode !== 200) {
                isFetching = false;
                return reject(new Error(`API respondió HTTP ${res.statusCode}`));
            }

            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);

            res.on('end', () => {
                isFetching = false;
                if (data.includes('previous instance') || data.includes('Please wait') || data.includes('running')) {
                    return reject(new Error("RESALES_CONCURRENCY_LOCK"));
                }

                let startTag = '';
                let endTag = '';
                const tagMatch = data.match(/<(Property_Item|Property|property_item|property)>/i);
                if (tagMatch) {
                    startTag = tagMatch[0];
                    endTag = startTag.replace('<', '</');
                } else {
                    return reject(new Error("NO_PROPERTY_TAGS_FOUND"));
                }

                const properties = [];
                const propertyBlocks = data.split(new RegExp(startTag, 'i'));
                propertyBlocks.shift();

                for (let block of propertyBlocks) {
                    const cleanBlock = block.split(new RegExp(endTag, 'i'))[0];
                    const parsed = parseSingleProperty(cleanBlock);
                    if (parsed) properties.push(parsed);
                }

                if (properties.length === 0) {
                    return reject(new Error("PARSED_ZERO_PROPERTIES"));
                }

                resolve(properties);
            });

            res.on('error', err => {
                isFetching = false;
                reject(err);
            });
        });

        req.on('timeout', () => {
            req.destroy();
            isFetching = false;
            reject(new Error("RESALES_CONNECTION_TIMEOUT"));
        });

        req.on('error', err => {
            isFetching = false;
            reject(err);
        });
    });
}

async function triggerFetchIfAllowed() {
    const timeSinceLast = Date.now() - lastFetchAttempt;
    const cooldownNeeded = (!cachedProperties || cachedProperties.length === 0) ? EMPTY_RETRY_COOLDOWN_MS : CACHE_DURATION;

    if (isFetching || (lastFetchAttempt > 0 && timeSinceLast < cooldownNeeded)) {
        return;
    }

    try {
        console.log("[Proxy Worker] Consultando catálogo a España...");
        const data = await fetchAndParseXml();
        if (data && data.length >= 10) {
            cachedProperties = data;
            lastCachedTime = Date.now();
            console.log(`[Proxy Worker SUCCESS] RAM poblada con ${cachedProperties.length} inmuebles.`);
        }
    } catch (err) {
        console.warn("[Proxy Worker WARN] Intento no completado:", err.message);
    }
}

// Bucle dinámico cada 30 segundos
setInterval(triggerFetchIfAllowed, 30000);
setTimeout(triggerFetchIfAllowed, 2000);

app.get('/api/properties', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;

    if (!cachedProperties || cachedProperties.length === 0) {
        triggerFetchIfAllowed();
        return res.status(200).json({
            status: "cooling_down",
            properties: [],
            total: 0,
            page,
            limit,
            hasMore: false,
            cachedAt: null,
            note: "Enfriamiento activo de España. Reintentando de forma dinámica..."
        });
    }

    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedItems = cachedProperties.slice(startIndex, endIndex);

    res.json({
        status: "success",
        properties: paginatedItems,
        total: cachedProperties.length,
        page,
        limit,
        hasMore: endIndex < cachedProperties.length,
        cachedAt: new Date(lastCachedTime).toISOString(),
        note: "Datos servidos desde memoria RAM protegida."
    });
});

app.listen(PORT, () => {
    console.log(`[Proxy] Listo en puerto ${PORT}`);
});
