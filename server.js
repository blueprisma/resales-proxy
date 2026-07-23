import express from 'express';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware CORS obligatorio para habilitar llamadas desde Wix Studio
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
const CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 Horas en RAM

// Parser robusto e insensible a mayúsculas/minúsculas
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
        
        // Mapeo preferente de PUEBLOS para Zuzanna: Town (Jávea, Dénia, Calpe...) -> Urbanización -> Área
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

function fetchXmlFromSpain(p1 = 1, p2 = 500) {
    return new Promise((resolve, reject) => {
        // Parametrización correcta exigida por la API de Resales-Online V3
        const url = `https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2&n=500&p1=${p1}&p2=${p2}&P_Inc=0`;

        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': '*/*'
            },
            timeout: 12000
        }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Estatus HTTP España: ${res.statusCode}`));
            }

            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', err => reject(err));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error("TIMEOUT_ESPAÑA"));
        });
        req.on('error', err => reject(err));
    });
}

async function syncCatalog() {
    if (isSyncing) return;
    isSyncing = true;
    console.log("[Proxy] Cargando catálogo desde España...");

    try {
        const rawXml = await fetchXmlFromSpain(1, 500);
        
        if (rawXml.includes('previous instance') || rawXml.includes('Please wait')) {
            console.warn("[Proxy] Servidor de España en enfriamiento.");
            return;
        }

        const parsed = parseXmlToProperties(rawXml);
        if (parsed.length > 0) {
            cachedProperties = parsed;
            lastCachedTime = Date.now();
            console.log(`[Proxy] Éxito: ${cachedProperties.length} propiedades hidratadas en memoria RAM.`);
        } else {
            console.warn("[Proxy] El XML recibido no contenía propiedades válidas.");
        }
    } catch (err) {
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
        status: "success",
        properties: paginatedItems,
        total: cachedProperties.length,
        page,
        limit,
        hasMore: endIndex < cachedProperties.length,
        cachedAt: lastCachedTime > 0 ? new Date(lastCachedTime).toISOString() : null
    });
});

app.listen(PORT, () => {
    console.log(`[Proxy] Servidor activo en puerto ${PORT}`);
});
