import express from 'express';
import zlib from 'zlib';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3000;

// Permisos CORS para comunicación segura con Wix Studio
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
const CACHE_DURATION = 2 * 60 * 60 * 1000; // 2 Horas

function parseXmlProperties(xmlString) {
    const properties = [];
    if (!xmlString || typeof xmlString !== 'string') return properties;

    // Normalizar etiquetas para soportar variaciones del Feed V3
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

function fetchRawXmlFromSpain() {
    return new Promise((resolve, reject) => {
        const url = "https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2";
        
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
                const xmlText = buffer.toString('utf8');
                resolve(xmlText);
            });
            stream.on('error', (err) => reject(err));
        }).on('error', (err) => reject(err));
    });
}

app.get('/api/properties', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const forceRefresh = req.query.refresh === 'true';

    try {
        const isCacheExpired = (Date.now() - lastCachedTime) > CACHE_DURATION;

        if (!cachedProperties || isCacheExpired || forceRefresh) {
            console.log("Descargando y descomprimiendo buffer de España...");
            const rawXml = await fetchRawXmlFromSpain();
            lastXmlPreview = rawXml.substring(0, 800);
            cachedProperties = parseXmlProperties(rawXml);
            lastCachedTime = Date.now();
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
        console.error("Error procesando el catálogo:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor activo en el puerto ${PORT}`);
});
