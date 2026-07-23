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
let lastStatusText = "Servidor listo. Esperando primera consulta.";

const PAGE_SIZE = 100;

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

function fetchXmlPage(shouldSendI) {
    return new Promise((resolve, reject) => {
        let url = `https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=${encodeURIComponent(RESALES_USER)}&P=${encodeURIComponent(RESALES_PASS)}&FV=2&N=${PAGE_SIZE}`;
        if (shouldSendI) {
            url += '&I=TRUE';
        }

        const options = {
            timeout: 45000,
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
                    return resolve({ status: 'WAIT', properties: [] });
                }

                let startTag = '';
                let endTag = '';
                const tagMatch = data.match(/<(Property_Item|Property|property_item|property)>/i);
                if (tagMatch) {
                    startTag = tagMatch[0];
                    endTag = startTag.replace('<', '</');
                } else {
                    return resolve({ status: 'EMPTY', properties: [] }); 
                }

                const properties = [];
                const propertyBlocks = data.split(new RegExp(startTag, 'i'));
                propertyBlocks.shift();

                for (let block of propertyBlocks) {
                    const cleanBlock = block.split(new RegExp(endTag, 'i'))[0];
                    const parsed = parseSingleProperty(cleanBlock);
                    if (parsed) properties.push(parsed);
                }

                resolve({ status: 'OK', properties });
            });

            res.on('error', err => reject(err));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error("TIMEOUT_CONNECTING_TO_SPAIN"));
        });

        req.on('error', err => reject(err));
    });
}

async function executeSingleFetch() {
    if (isSyncing) return;
    isSyncing = true;

    const isClean = !hasPerformedCleanLoad;
    lastStatusText = `Conectando con España (${isClean ? 'Clean Load' : 'Incremental'})...`;

    try {
        let result = await fetchXmlPage(isClean);

        if (result.status === 'WAIT') {
            lastStatusText = "España está procesando la solicitud. Esperando 20 segundos de silencio...";
            await wait(20000);
            result = await fetchXmlPage(false); // Segundo intento sin I=TRUE
        }

        const properties = result.properties || [];

        if (properties.length > 0) {
            for (const p of properties) {
                cachedPropertiesMap.set(p._id, p);
            }
            hasPerformedCleanLoad = true;
            lastCachedTime = Date.now();
            lastStatusText = "Sincronización exitosa.";
        } else {
            lastStatusText = "España respondió con 0 propiedades o aún empaquetando.";
        }

    } catch (err) {
        console.warn("[Proxy Error]:", err.message);
        lastStatusText = `Error: ${err.message}`;
    } finally {
        isSyncing = false;
    }
}

app.get('/api/properties', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;

    // Si la RAM está vacía y no hay proceso corriendo, dispara UNA SOLA llamada limpia
    if (cachedPropertiesMap.size === 0 && !isSyncing) {
        executeSingleFetch();
    }

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
            note: lastStatusText
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
        note: "Servido desde RAM protegida."
    });
});

app.listen(PORT, () => {
    console.log(`[Proxy] Servidor listo en puerto ${PORT}`);
});
