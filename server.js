import express from 'express';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3000;

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

function parsePropertiesFromXml(xmlString) {
    const properties = [];
    if (!xmlString || typeof xmlString !== 'string') return properties;

    let cleanXml = xmlString.replace(/<(?:Property|property)\b/gi, '<Property').replace(/<\/(?:Property|property)>/gi, '</Property>');
    if (!cleanXml.includes('<Property')) return properties;

    const propertyBlocks = cleanXml.split('<Property');
    propertyBlocks.shift();

    for (let rawBlock of propertyBlocks) {
        const block = rawBlock.split('</Property>')[0];

        const getTagValue = (tag) => {
            const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
            const match = block.match(regex);
            return match ? match[1].trim() : '';
        };

        const propertyid = getTagValue('Reference') || getTagValue('PropertyRefNo') || getTagValue('RefNo') || getTagValue('id') || '';
        if (!propertyid) continue;

        const title = getTagValue('Title') || `Propiedad Ref: ${propertyid}`;
        
        // Mapeo preciso de PUEBLOS (Jávea, Dénia, Calpe, Altea, Moraira...)
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

function fetchBatch(p1 = 1, p2 = 500) {
    return new Promise((resolve, reject) => {
        const url = `https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2&n=500&p1=${p1}&p2=${p2}&P_Inc=0`;

        https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': '*/*'
            }
        }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Estatus HTTP España: ${res.statusCode}`));
            }

            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', err => reject(err));
        }).on('error', err => reject(err));
    });
}

async function downloadAllPropertiesInBatches() {
    if (isSyncing) return;
    isSyncing = true;

    console.log("[Proxy] Iniciando Carga Progresiva Instantánea (P_Inc=0)...");
    let allItems = [];
    let p1 = 1;
    let p2 = 500;
    let hasMore = true;
    let consecutiveErrors = 0;

    while (hasMore && consecutiveErrors < 3) {
        try {
            console.log(`[Proxy] Descargando lote ${p1} a ${p2}...`);
            const xmlData = await fetchBatch(p1, p2);

            if (xmlData.includes('previous instance') || xmlData.includes('Please wait')) {
                console.warn("[Proxy] Enfriamiento detectado en España.");
                break;
            }

            const parsedBatch = parsePropertiesFromXml(xmlData);

            if (parsedBatch.length === 0) {
                hasMore = false;
            } else {
                allItems = allItems.concat(parsedBatch);
                // CLAVE TÉCNICA: Publicamos el lote en RAM INMEDIATAMENTE para responder al usuario sin demoras
                cachedProperties = [...allItems];
                lastCachedTime = Date.now();
                p1 += 500;
                p2 += 500;
                await new Promise(r => setTimeout(r, 200));
            }
        } catch (err) {
            console.error(`[Proxy] Error en lote ${p1}-${p2}:`, err.message);
            consecutiveErrors++;
        }
    }

    isSyncing = false;
}

app.get('/api/properties', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const forceRefresh = req.query.refresh === 'true';

    try {
        const isExpired = (Date.now() - lastCachedTime) > CACHE_DURATION;

        if (forceRefresh) {
            cachedProperties = [];
            lastCachedTime = 0;
        }

        if (cachedProperties.length === 0 || isExpired) {
            if (!isSyncing) {
                downloadAllPropertiesInBatches();
            }

            // Aguardamos máximo 3 segundos para servir AL MENOS el primer bloque de 500 propiedades
            let waitCount = 0;
            while (cachedProperties.length === 0 && waitCount < 6) {
                await new Promise(r => setTimeout(r, 500));
                waitCount++;
            }

            if (cachedProperties.length === 0) {
                return res.json({
                    status: "processing",
                    message: "Iniciando descarga inicial con España. Recarga en 5 segundos.",
                    total: 0,
                    properties: []
                });
            }
        }

        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const paginatedItems = cachedProperties.slice(startIndex, endIndex);

        res.json({
            status: "success",
            isSyncing,
            properties: paginatedItems,
            total: cachedProperties.length,
            page,
            limit,
            hasMore: endIndex < cachedProperties.length,
            cachedAt: new Date(lastCachedTime).toISOString()
        });

    } catch (error) {
        console.error("[Proxy Error]:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`[Proxy] Servidor corriendo en puerto ${PORT}`);
});
