import express from 'express';

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

// Variables de caché en memoria RAM (Duración: 2 horas)
let cachedProperties = null;
let lastCachedTime = 0;
const CACHE_DURATION = 2 * 60 * 60 * 1000;

function parseXmlProperties(xmlString) {
    const properties = [];
    if (!xmlString || typeof xmlString !== 'string') return properties;

    // Normalizar etiquetas para evitar fallos por variaciones de mayúsculas/minúsculas
    const cleanXml = xmlString.replace(/<property>/gi, '<Property>').replace(/<\/property>/gi, '</Property>');
    if (!cleanXml.includes('<Property>')) return properties;

    const propertyBlocks = cleanXml.split('<Property>');
    propertyBlocks.shift(); // Quitar la cabecera XML

    for (let block of propertyBlocks) {
        block = block.split('</Property>')[0];

        const getTagValue = (tag) => {
            const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
            const match = block.match(regex);
            return match ? match[1].trim() : '';
        };

        const propertyid = getTagValue('PropertyRefNo') || getTagValue('Reference') || getTagValue('RefNo') || getTagValue('id') || '';
        if (!propertyid) continue;

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
        const picturesMatch = block.match(/<Pictures[^>]*>([\s\S]*?)<\/Pictures>/i) || block.match(/<images[^>]*>([\s\S]*?)<\/images>/i);
        if (picturesMatch) {
            const urlMatches = picturesMatch[1].match(/<Url[^>]*>([^<]*)<\/Url>/gi) || picturesMatch[1].match(/<url[^>]*>([^<]*)<\/url>/gi);
            if (urlMatches) {
                images = urlMatches.map(m => m.replace(/<\/?(?:Url|url)[^>]*>/gi, '').trim());
            }
        }

        if (images.length === 0) {
            const urlMatches = block.match(/<Url[^>]*>([^<]*)<\/Url>/gi) || block.match(/<url[^>]*>([^<]*)<\/url>/gi);
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

async function fetchXmlFromSpain() {
    const url = "https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2";
    
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/xml, text/xml, */*'
        }
    });

    if (!response.ok) {
        throw new Error(`Resales Online respondió con estatus HTTP ${response.status}`);
    }

    const xmlText = await response.text();
    return parseXmlProperties(xmlText);
}

app.get('/api/properties', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const forceRefresh = req.query.refresh === 'true';

    try {
        const isCacheExpired = (Date.now() - lastCachedTime) > CACHE_DURATION;

        if (!cachedProperties || isCacheExpired || forceRefresh) {
            console.log("Iniciando descarga y descompresión nativa del XML masivo en Render...");
            cachedProperties = await fetchXmlFromSpain();
            lastCachedTime = Date.now();
            console.log(`Descarga y parseo finalizado. Registros en memoria: ${cachedProperties.length}`);
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
        console.error("Error procesando el catálogo de España:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor activo en el puerto ${PORT}`);
});
