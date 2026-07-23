import express from 'express';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware CORS habilitado para conexiones desde Wix Studio y Velo
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

let cachedProperties = [];
let lastCachedTime = 0;
let isSyncing = false;
let lastError = null;
const CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 Horas en memoria RAM

// Extractor e interpretador de propiedades XML
function parseXmlToProperties(xmlString) {
    const properties = [];
    if (!xmlString || typeof xmlString !== 'string') return properties;

    let cleanXml = xmlString.replace(/<(?:Property|property)\b/gi, '<Property').replace(/<\/(?:Property|property)>/gi, '</Property>');
    if (!cleanXml.includes('<Property')) return properties;

    const blocks = cleanXml.split('<Property');
    blocks.shift();

    for (let rawBlock of blocks) {
        const block = rawBlock.split('</Property>')[0];

        const getTagValue = (tag) => {
            const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
            const match = block.match(regex);
            return match ? match[1].trim() : '';
        };

        const propertyid = getTagValue('Reference') || getTagValue('PropertyRefNo') || getTagValue('RefNo') || getTagValue('id') || '';
        if (!propertyid) continue;

        const title = getTagValue('Title') || `Propiedad Ref: ${propertyid}`;
        
        // Mapeo preferente de PUEBLOS: Town (Jávea, Dénia, Calpe...) -> Urbanización -> Área
        const pueblo = getTagValue('Town') || getTagValue('City') || getTagValue('Municipality');
        const urbanizacion = getTagValue('Location') || getTagValue('Urbanisation');
        const areaMacro = getTagValue('Area') || 'Costa Blanca';
        const location = pueblo || urbanizacion || areaMacro;

        const isNewDev = getTagValue('NewDevelopment') === '1' || getTagValue('NewDevelopment') === 'true';
        const marketType = isNewDev ? 'New Development' : 'Resale';
        const price = parseFloat(getTagValue('Price')) || 0;
        const beds = parseInt(getTagValue('Bedrooms')) || parseInt(getTagValue('Beds')) || 0;
        const baths = parseInt(getTagValue('Bathrooms')) || parseInt(getTagValue('Baths')) || 0;
        const sqm = parseFloat(getTagValue('Built')) || parseFloat(getTagValue('sqm')) || 0;
        const propertyType = getTagValue('Type') || 'Property';
        const description = getTagValue('Description') || getTagValue('Desc') || '';

        let images = [];
        const picturesMatch = block.match(/<Pictures[^>]*>([\s\S]*?)<\/Pictures>/i);
        if (picturesMatch) {
            const urlMatches = picturesMatch[1].match(/<Url[^>]*>([^<]*)<\/Url>/gi);
            if (urlMatches) {
                images = urlMatches.map(m => m.replace(/<\/?Url[^>]*>/gi, '').trim());
            }
        }

        const mainimage = images.length > 0 ? images[0] : 'https://wixideas.wixsite.com/images/placeholder.png';

        properties.push({
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
        });
    }

    return properties;
}

function fetchXmlFromSpain(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': '*/*'
            },
            timeout: 15000
        }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} de España`));
            }

            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', err => reject(err));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error("Timeout de conexión con España (15s)"));
        });
        req.on('error', err => reject(err));
    });
}

async function syncCatalog() {
    if (isSyncing) return;
    isSyncing = true;
    lastError = null;
    console.log("[Proxy] Solicitando propiedades a España...");

    const primaryUrl = `https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2&n=500&p1=1&p2=500&P_Inc=0`;
    const fallbackUrl = `https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2`;

    try {
        let rawXml = await fetchXmlFromSpain(primaryUrl);

        if (rawXml.includes('previous instance') || rawXml.includes('Please wait') || rawXml.length < 300) {
            console.warn("[Proxy] Respuesta corta o bloqueo detectado. Intentando URL secundaria...");
            rawXml = await fetchXmlFromSpain(fallbackUrl);
        }

        const parsed = parseXmlToProperties(rawXml);
        if (parsed.length > 0) {
            cachedProperties = parsed;
            lastCachedTime = Date.now();
            console.log(`[Proxy] Éxito: ${cachedProperties.length} propiedades en RAM.`);
        } else {
            lastError = "El XML recibido de España no contiene propiedades con los filtros actuales.";
            console.warn("[Proxy]", lastError);
        }
    } catch (err) {
        lastError = err.message;
        console.error("[Proxy Error]:", err.message);
    } finally {
        isSyncing = false;
    }
}

app.get('/api/properties', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const forceRefresh = req.query.refresh === 'true';

    const isExpired = (Date.now() - lastCachedTime) > CACHE_DURATION;

    if (cachedProperties.length === 0 || isExpired || forceRefresh) {
        await syncCatalog();
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
        note: lastError || (cachedProperties.length === 0 ? "Iniciando carga de datos..." : null)
    });
});

app.listen(PORT, () => {
    console.log(`[Proxy] Servidor activo en puerto ${PORT}`);
});
