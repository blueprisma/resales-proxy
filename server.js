import express from 'express';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3000;

// La caché se inicializa en null de manera estricta para evitar la contaminación con arrays vacíos []
let cachedProperties = null;
let lastCachedTime = 0;
const CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 Horas
const MIN_VALID_CATALOG_SIZE = 30; // Bloqueo si el lote degradado es menor a 30

// Middleware de CORS completo
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

app.use(express.json());

// Saneamiento de textos con prioridad en traducción al español <es>
function getCleanTagValue(block, tag) {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const match = block.match(regex);
    if (!match) return '';
    
    const innerContent = match[1].trim();

    const esMatch = innerContent.match(/<es[^>]*>([\s\S]*?)<\/es>/i);
    if (esMatch) {
        return esMatch[1].trim();
    }

    if (innerContent.includes('<') && innerContent.includes('>')) {
        return innerContent.replace(/<[^>]*>/g, '').trim();
    }

    return innerContent;
}

// Procesador individual para cada propiedad
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
    return new Promise((resolve, reject) => {
        const url = "https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2&P_Inc=0&n=1000&i=True";
        
        const req = https.get(url, { timeout: 25000 }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`API de origen respondió HTTP: ${res.statusCode}`));
                return;
            }

            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });

            res.on('end', () => {
                const hasLockMessage = data.includes('previous instance') || 
                                       data.includes('Please wait') || 
                                       data.includes('running');
                if (hasLockMessage) {
                    reject(new Error("RESALES_CONCURRENCY_LOCK"));
                    return;
                }

                let startTag = '';
                let endTag = '';

                const tagMatch = data.match(/<(Property_Item|Property|property_item|property)>/i);
                if (tagMatch) {
                    startTag = tagMatch[0];
                    endTag = startTag.replace('<', '</');
                } else {
                    const err = new Error("NO_PROPERTY_TAGS_FOUND");
                    reject(err);
                    return;
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
                    reject(new Error("PARSED_ZERO_PROPERTIES"));
                    return;
                }

                resolve(properties);
            });

            res.on('error', (err) => reject(err));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error("RESALES_CONNECTION_TIMEOUT"));
        });

        req.on('error', (err) => reject(err));
    });
}

app.get('/api/properties', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const forceRefresh = req.query.refresh === 'true';

    const isCacheExpired = (Date.now() - lastCachedTime) > CACHE_DURATION;
    let remoteCooldownActive = false;
    let warningMessage = null;

    if (!cachedProperties || cachedProperties.length === 0 || isCacheExpired || forceRefresh) {
        console.log("[Proxy] Solicitando actualización de datos a España...");
        try {
            const fetchedData = await fetchAndParseXml();
            
            if (cachedProperties && cachedProperties.length >= MIN_VALID_CATALOG_SIZE && fetchedData.length < MIN_VALID_CATALOG_SIZE) {
                remoteCooldownActive = true;
                warningMessage = `Lote externo degradado (${fetchedData.length} propiedades). Se retiene el catálogo saludable de ${cachedProperties.length} propiedades en RAM.`;
            } else {
                cachedProperties = fetchedData;
                lastCachedTime = Date.now();
                console.log(`[Proxy] Caché de RAM actualizada con éxito: ${cachedProperties.length} inmuebles.`);
            }
        } catch (error) {
            console.warn("[Proxy] La llamada remota falló:", error.message);
            remoteCooldownActive = true;
            warningMessage = error.message;

            if (!cachedProperties || cachedProperties.length === 0) {
                return res.status(503).json({
                    status: "cooling_down",
                    properties: [],
                    total: 0,
                    page,
                    limit,
                    hasMore: false,
                    cachedAt: null,
                    remote_cooldown: true,
                    note: "El servidor proxy está en período de enfriamiento. Reintentando automáticamente...",
                    warning: error.message
                });
            }
        }
    }

    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedItems = cachedProperties.slice(startIndex, endIndex);

    res.json({
        status: remoteCooldownActive ? "ready" : "success",
        properties: paginatedItems,
        total: cachedProperties.length,
        page,
        limit,
        hasMore: endIndex < cachedProperties.length,
        cachedAt: lastCachedTime > 0 ? new Date(lastCachedTime).toISOString() : null,
        remote_cooldown: remoteCooldownActive,
        note: "Sincronización de caché activa y saludable.",
        warning: warningMessage
    });
});

app.listen(PORT, () => {
    console.log(`[Proxy] Servidor corriendo en el puerto ${PORT}`);
});
