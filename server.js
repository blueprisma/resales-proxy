import express from 'express';
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

// Variables de caché en memoria RAM
let cachedProperties = null;
let lastCachedTime = 0;
const CACHE_DURATION = 2 * 60 * 60 * 1000; // 2 horas

function parseSingleProperty(block) {
    const getTagValue = (tag) => {
        const regex = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i');
        const match = block.match(regex);
        return match ? match[1].trim() : '';
    };

    const propertyid = getTagValue('PropertyRefNo') || getTagValue('Reference') || getTagValue('RefNo') || '';
    if (!propertyid) return null;

    const title = getTagValue('Title') || `Propiedad Ref: ${propertyid}`;
    const location = getTagValue('Area') || getTagValue('Location') || getTagValue('Town') || 'Costa Blanca';
    const isNewDev = getTagValue('NewDevelopment') === '1' || getTagValue('NewDevelopment') === 'true';
    const marketType = isNewDev ? 'New Development' : 'Resale';
    const price = parseFloat(getTagValue('Price')) || 0;
    const beds = parseInt(getTagValue('Bedrooms')) || parseInt(getTagValue('Beds')) || 0;
    const baths = parseInt(getTagValue('Bathrooms')) || parseInt(getTagValue('Baths')) || 0;
    const sqm = parseFloat(getTagValue('Built')) || parseFloat(getTagValue('sqm')) || 0;
    const propertyType = getTagValue('Type') || 'Property';
    const description = getTagValue('Description') || getTagValue('Desc') || '';

    let images = [];
    const picturesMatch = block.match(/<Pictures>([\s\S]*?)<\/Pictures>/i) || block.match(/<images>([\s\S]*?)<\/images>/i);
    if (picturesMatch) {
        const urlMatches = picturesMatch[1].match(/<Url>([^<]*)<\/Url>/gi) || picturesMatch[1].match(/<url>([^<]*)<\/url>/gi);
        if (urlMatches) {
            images = urlMatches.map(m => m.replace(/<\/?(?:Url|url)>/gi, '').trim());
        }
    }

    if (images.length === 0) {
        const urlMatches = block.match(/<Url>([^<]*)<\/Url>/gi) || block.match(/<url>([^<]*)<\/url>/gi);
        if (urlMatches) {
            images = urlMatches.map(m => m.replace(/<\/?(?:Url|url)>/gi, '').trim());
        }
    }

    const mainimage = images.length > 0 ? images[0] : '';

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

async function fetchAndParseXmlStream() {
    return new Promise((resolve, reject) => {
        const url = "https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2";
        
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Resales-Online retornó estatus: ${res.statusCode}`));
                return;
            }

            const properties = [];
            let buffer = '';

            res.setEncoding('utf8');

            res.on('data', (chunk) => {
                buffer += chunk;
                let propertyIndex = buffer.indexOf('<Property>');
                if (propertyIndex === -1) propertyIndex = buffer.indexOf('<property>');

                while (propertyIndex !== -1) {
                    let closingIndex = buffer.indexOf('</Property>', propertyIndex);
                    if (closingIndex === -1) closingIndex = buffer.indexOf('</property>', propertyIndex);
                    
                    if (closingIndex === -1) break; 

                    const block = buffer.substring(propertyIndex + 10, closingIndex);
                    const parsed = parseSingleProperty(block);
                    
                    if (parsed) {
                        properties.push(parsed);
                    }

                    buffer = buffer.substring(closingIndex + 11);
                    propertyIndex = buffer.indexOf('<Property>');
                    if (propertyIndex === -1) propertyIndex = buffer.indexOf('<property>');
                }
            });

            res.on('end', () => {
                resolve(properties);
            });

            res.on('error', (err) => reject(err));
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
            console.log("Iniciando descarga y parseo del XML masivo en Render...");
            cachedProperties = await fetchAndParseXmlStream();
            lastCachedTime = Date.now();
            console.log(`Descarga finalizada. Registros en caché: ${cachedProperties.length}`);
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
            hasMore: endIndex < cachedProperties.length
        });
    } catch (error) {
        console.error("Error en el procesamiento del feed:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor activo en el puerto ${PORT}`);
});
