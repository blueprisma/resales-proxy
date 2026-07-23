import express from 'express';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3000;

// Variables de caché en memoria RAM
let cachedProperties = null;
let lastCachedTime = 0;
const CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 Horas
const MIN_CATALOG_THRESHOLD = 5; // Umbral mínimo para aceptar un XML como válido

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
    
    const location = getCleanTagValue(block, 'town') || 
                     getCleanTagValue(block, 'city') || 
                     getCleanTagValue(block, 'area') || 
                     getCleanTagValue(block, 'location') || 
                     'Costa Blanca';

    const isNewDev = getCleanTagValue(block, 'newdevelopment') === '1' || 
                     getCleanTagValue(block, 'newdevelopment') === 'true' || 
                     getCleanTagValue(block, 'new_development') === '1';
                     
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
    return new Promise((resolve, reject) => {
        const url = "https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2&P_Inc=0";
        
        const req = https.get(url, { timeout: 20000 }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`API respondió HTTP: ${res.statusCode}`));
            }

            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);

            res.on('end', () => {
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
                    const err = new Error("NO_PROPERTY_TAGS_FOUND");
                    err.rawXmlSnippet = data.substring(0, 500);
                    return reject(err);
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
            reject(new Error("RESALES_CONNECTION_TIMEOUT"));
        });

        req.on('error', err => reject(err));
    });
}

app.get('/api/properties', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const forceRefresh = req.query.refresh === 'true';

    const isExpired = (Date.now() - lastCachedTime) > CACHE_DURATION;
    let remoteCooldownActive = false;
    let warningMessage = null;

    if (!cachedProperties || cachedProperties.length < MIN_CATALOG_THRESHOLD || isExpired || forceRefresh) {
        console.log("[Proxy] Consultando catálogo a España...");
        try {
            const fetchedData = await fetchAndParseXml();
            
            // ESCUDO ANTI-CONTAMINACIÓN: Rechaza paquetes < 5 si ya hay caché o si España responde recortado
            if (fetchedData.length >= MIN_CATALOG_THRESHOLD) {
                cachedProperties = fetchedData;
                lastCachedTime = Date.now();
                console.log(`[Proxy] RAM hidrata con éxito: ${cachedProperties.length} inmuebles.`);
            } else {
                console.warn(`[Proxy Guard] España envió sólo ${fetchedData.length} inmuebles por bloqueo de 10 min.`);
                remoteCooldownActive = true;
                warningMessage = `API en enfriamiento (Devolvió ${fetchedData.length} ítems). Reteniendo inventario anterior.`;
                if (!cachedProperties) cachedProperties = [];
            }
        } catch (error) {
            console.warn("[Proxy Warning] Error remoto:", error.message);
            remoteCooldownActive = true;
            warningMessage = error.message;
            if (!cachedProperties) cachedProperties = [];
        }
    }

    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedItems = cachedProperties.slice(startIndex, endIndex);

    res.json({
        status: (cachedProperties.length >= MIN_CATALOG_THRESHOLD) ? "success" : "ready",
        properties: paginatedItems,
        total: cachedProperties.length,
        page,
        limit,
        hasMore: endIndex < cachedProperties.length,
        cachedAt: lastCachedTime > 0 ? new Date(lastCachedTime).toISOString() : null,
        remote_cooldown: remoteCooldownActive,
        note: warningMessage || "Sincronización activa y saludable."
    });
});

app.listen(PORT, () => {
    console.log(`[Proxy] Servidor operativo en puerto ${PORT}`);
});
