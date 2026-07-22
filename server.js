import express from 'express';
import zlib from 'zlib';
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

let cachedProperties = null;
let lastCachedTime = 0;
let lastXmlPreview = '';
const CACHE_DURATION = 2 * 60 * 60 * 1000; // 2 Horas de caché en RAM

function parseXmlProperties(xmlString) {
    const properties = [];
    if (!xmlString || typeof xmlString !== 'string') return properties;

    let cleanXml = xmlString;
    cleanXml = cleanXml.replace(/<(?:Property|property|PropertyDetails|property_details)\b/gi, '<Property');
    cleanXml = cleanXml.replace(/<\/(?:Property|property|PropertyDetails|property_details)>/gi, '</Property>');

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

        const propertyid = getTagValue('PropertyRefNo') || getTagValue('Reference') || getTagValue('RefNo') || getTagValue('id') || getTagValue('ID') || '';
        if (!propertyid) continue;

        const title = getTagValue('Title') || `Propiedad Ref: ${propertyid}`;
        const location = getTagValue('Area') || getTagValue('Location') || getTagValue('Town') || 'Costa Blanca';
        const isNewDev = getTagValue('NewDevelopment') === '1' || getTagValue('NewDevelopment') === 'true';
        const marketType = isNewDev ? 'New Development' : 'Resale';
        const price = parseFloat(getTagValue('Price')) || 0;
        const beds = parseInt(getTagValue('Bedrooms')) || parseInt(getTagValue('Beds')) || 0;
        const baths = parseInt(getTagValue('Bathrooms')) || parseInt(getTagValue('Baths')) || 0;
        const sqm = parseFloat(getTagValue('Built')) || parseFloat(getTagValue('sqm')) || 0;
        const propertyType = getTagValue('Type') || getTagValue('PropertyType') || 'Property';
        const description = getTagValue('Description') || getTagValue('Desc') || '';

        let images = [];
        const picturesMatch = block.match(/<(?:Pictures|images|Pictures_List)[^>]*>([\s\S]*?)<\/(?:Pictures|images|Pictures_List)>/i);
        if (picturesMatch) {
            const urlMatches = picturesMatch[1].match(/<(?:Url|url)[^>]*>([^<]*)<\/(?:Url|url)>/gi);
            if (urlMatches) {
                images = urlMatches.map(m => m.replace(/<\/?(?:Url|url)[^>]*>/gi, '').trim());
            }
        }

        if (images.length === 0) {
            const urlMatches = block.match(/<(?:Url|url)[^>]*>([^<]*)<\/(?:Url|url)>/gi);
            if (urlMatches) {
                images = urlMatches.map(m => m.replace(/<\/?(?:Url|url)[^>]*>/gi, '').trim());
            }
        }

        const mainimage = images.length > 0 ? images[0] : '';

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

function fetchXmlUrl(url) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Encoding': 'gzip, deflate',
                'Accept': '*/*'
            }
        }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Estatus HTTP de España: ${res.statusCode}`));
            }

            let stream = res;
            const encoding = res.headers['content-encoding'];

            if (encoding === 'gzip') {
                stream = res.pipe(zlib.createGunzip());
            } else if (encoding === 'deflate') {
                stream = res.pipe(zlib.createInflate());
            }

            let chunks = [];
            stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            stream.on('end', () => {
                const buffer = Buffer.concat(chunks);
                resolve(buffer.toString('utf8'));
            });
            stream.on('error', (err) => reject(err));
        }).on('error', (err) => reject(err));
    });
}

async function fetchXmlFromSpain() {
    const productionUrl = "https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2";
    const xmlText = await fetchXmlUrl(productionUrl);

    // Detección explícita del bloqueo de 10 minutos de Resales Online
    if (xmlText.includes('error_message') || xmlText.includes('previous instance')) {
        console.warn("Resales Online reporta bloqueo por limite de tiempo (10 min cooldown).");
        lastXmlPreview = xmlText;
        return { items: [], isRateLimited: true, rawXml: xmlText };
    }

    const items = parseXmlProperties(xmlText);
    lastXmlPreview = xmlText.substring(0, 800);
    return { items, isRateLimited: false, rawXml: xmlText };
}

app.get('/api/properties', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const forceRefresh = req.query.refresh === 'true';

    try {
        const isCacheExpired = (Date.now() - lastCachedTime) > CACHE_DURATION;

        if (!cachedProperties || isCacheExpired || forceRefresh) {
            console.log("Solicitando catálogo a Resales Online...");
            const { items, isRateLimited } = await fetchXmlFromSpain();

            if (isRateLimited && cachedProperties && cachedProperties.length > 0) {
                console.log("Usando versión en caché previa mientras se libera el bloqueo de España.");
            } else {
                cachedProperties = items;
                if (!isRateLimited) {
                    lastCachedTime = Date.now();
                }
            }
        }

        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const paginatedItems = cachedProperties.slice(startIndex, endIndex);

        res.json({
            success: true,
            properties: paginatedItems,
            total: cachedProperties.length,
            page,
            limit,
            hasMore: endIndex < cachedProperties.length,
            debugPreview: cachedProperties.length === 0 ? lastXmlPreview : undefined
        });
    } catch (error) {
        console.error("Error procesando el catálogo de producción:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor activo en el puerto ${PORT}`);
});
