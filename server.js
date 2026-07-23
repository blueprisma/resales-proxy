import express from 'express';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware CORS obligatorio para habilitar solicitudes desde Wix Studio / Velo
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

let cachedProperties = null;
let lastCachedTime = 0;
let isSyncing = false;
let lastError = null;
const CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 Horas en memoria RAM

// Extractor de valores con soporte para nodos multilingües (<es> / <uk>)
function getTagValue(block, tag) {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const match = block.match(regex);
    if (!match) return '';
    let val = match[1].trim();
    
    if (val.includes('<')) {
        const esMatch = val.match(/<es[^>]*>([\s\S]*?)<\/es>/i);
        if (esMatch) return esMatch[1].trim();
        const ukMatch = val.match(/<uk[^>]*>([\s\S]*?)<\/uk>/i);
        if (ukMatch) return ukMatch[1].trim();
        val = val.replace(/<[^>]+>/g, '').trim();
    }
    return val;
}

// Interpreter individual de cada inmueble
function parseSingleProperty(block) {
    // LECTURA DIRECTA DE <id> SEGÚN AUDITORÍA
    const propertyid = getTagValue(block, 'id') || getTagValue(block, 'reference') || getTagValue(block, 'propertyrefno') || getTagValue(block, 'ref');
    if (!propertyid) return null;

    const title = getTagValue(block, 'title') || `Propiedad Ref: ${propertyid}`;
    
    // Mapeo preferente de PUEBLOS: Town (Jávea, Dénia, Calpe...) -> Urbanización -> Área Macro
    const pueblo = getTagValue(block, 'town') || getTagValue(block, 'city') || getTagValue(block, 'municipality');
    const urbanizacion = getTagValue(block, 'urbanisation') || getTagValue(block, 'urbanization');
    const areaMacro = getTagValue(block, 'area') || getTagValue(block, 'location') || 'Costa Blanca';
    const location = pueblo || urbanizacion || areaMacro;

    const isNewDev = getTagValue(block, 'newdevelopment') === '1' || getTagValue(block, 'newdevelopment') === 'true';
    const marketType = isNewDev ? 'New Development' : 'Resale';
    const price = parseFloat(getTagValue(block, 'price')) || 0;
    const beds = parseInt(getTagValue(block, 'bedrooms')) || parseInt(getTagValue(block, 'beds')) || 0;
    const baths = parseInt(getTagValue(block, 'bathrooms')) || parseInt(getTagValue(block, 'baths')) || 0;
    const sqm = parseFloat(getTagValue(block, 'built')) || parseFloat(getTagValue(block, 'sqm')) || 0;
    const propertyType = getTagValue(block, 'type') || getTagValue(block, 'subtype') || 'Property';
    const description = getTagValue(block, 'description') || getTagValue(block, 'desc') || '';

    // Extractor universal de imágenes por extensión
    let images = [];
    const picturesMatch = block.match(/<(?:pictures|images|photos)[^>]*>([\s\S]*?)<\/(?:pictures|images|photos)>/i);
    const searchTarget = picturesMatch ? picturesMatch[1] : block;
    const urlMatches = searchTarget.match(/https?:\/\/[^\s"<>]+\.(?:jpg|jpeg|png|webp|gif)/gi);
    if (urlMatches) {
        images = [...new Set(urlMatches)];
    }

    const mainimage = images.length > 0 ? images[0] : 'https://wixideas.wixsite.com/images/placeholder.png';

    return {
        _id: propertyid,
        title,
        location,
        marketType,
        price,
        beds,
        baths,
        mainimage,
        propertyid,
        sqm,
        propertyType,
        images: images.join(','),
        description
    };
}

// Descarga en memoria sin filtros restrictivos
async function fetchAndParseXml() {
    return new Promise((resolve, reject) => {
        const url = "https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2&P_Inc=0";
        
        const req = https.get(url, { 
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': '*/*'
            },
            timeout: 25000 
        }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Estatus HTTP España: ${res.statusCode}`));
            }

            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);

            res.on('end', () => {
                if (data.includes('previous instance') || data.includes('Please wait')) {
                    return reject(new Error("RESALES_CONCURRENCY_LOCK"));
                }

                // EXTRACCIÓN GLOBAL ROBUSTA DE BLOQUES <property>
                const propertyBlocks = data.match(/<\s*(?:property|property_item)\b[\s\S]*?>([\s\S]*?)<\/\s*(?:property|property_item)\s*>/gi);
                
                if (!propertyBlocks || propertyBlocks.length === 0) {
                    const err = new Error("PARSED_ZERO_PROPERTIES");
                    err.rawXmlSnippet = data.substring(0, 500);
                    return reject(err);
                }

                const properties = [];
                for (let block of propertyBlocks) {
                    const parsed = parseSingleProperty(block);
                    if (parsed) {
                        properties.push(parsed);
                    }
                }

                if (properties.length === 0) {
                    const err = new Error("PARSED_ZERO_PROPERTIES");
                    err.rawXmlSnippet = data.substring(0, 500);
                    return reject(err);
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

// Endpoint Principal de API
app.get('/api/properties', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const forceRefresh = req.query.refresh === 'true';

    const isExpired = (Date.now() - lastCachedTime) > CACHE_DURATION;
    let remoteCooldownActive = false;

    if (!cachedProperties || cachedProperties.length === 0 || isExpired || forceRefresh) {
        if (!isSyncing) {
            isSyncing = true;
            console.log("[Proxy] Descargando catálogo desde España...");
            try {
                const fetchedData = await fetchAndParseXml();
                cachedProperties = fetchedData;
                lastCachedTime = Date.now();
                lastError = null;
                console.log(`[Proxy] Éxito. Inmuebles en RAM: ${cachedProperties.length}`);
            } catch (error) {
                console.warn("[Proxy Error]:", error.message);
                remoteCooldownActive = true;
                lastError = error.message;
                if (!cachedProperties) cachedProperties = [];
            } finally {
                isSyncing = false;
            }
        }
    }

    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedItems = cachedProperties.slice(startIndex, endIndex);

    res.json({
        status: cachedProperties.length > 0 ? "success" : "ready",
        properties: paginatedItems,
        total: cachedProperties.length,
        page,
        limit,
        hasMore: endIndex < cachedProperties.length,
        cachedAt: lastCachedTime > 0 ? new Date(lastCachedTime).toISOString() : null,
        remote_cooldown: remoteCooldownActive,
        note: lastError || null
    });
});

app.listen(PORT, () => {
    console.log(`[Proxy] Servidor listo en puerto ${PORT}`);
});
