import express from 'express';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3000;

// Caché interna en memoria RAM de largo ciclo de vida
let cachedProperties = null;
let lastCachedTime = 0;
const CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 Horas

// Extractor inteligente de etiquetas con soporte para sub-etiquetas anidadas (<es>, <uk>)
function parseSingleProperty(block) {
    const getTagValue = (tag) => {
        const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
        const match = block.match(regex);
        if (!match) return '';
        let val = match[1].trim();
        
        // Si la etiqueta contiene sub-nodos en idioma (<es> / <uk>), extrae preferentemente el español
        if (val.includes('<')) {
            const esMatch = val.match(/<es[^>]*>([\s\S]*?)<\/es>/i);
            if (esMatch) return esMatch[1].trim();
            const ukMatch = val.match(/<uk[^>]*>([\s\S]*?)<\/uk>/i);
            if (ukMatch) return ukMatch[1].trim();
            val = val.replace(/<[^>]+>/g, '').trim();
        }
        return val;
    };

    // CORRECCIÓN CRÍTICA: Priorizamos <id> que es como responde la API V3 de España
    const propertyid = getTagValue('id') || getTagValue('Reference') || getTagValue('PropertyRefNo') || getTagValue('RefNo') || '';
    if (!propertyid) return null;

    const title = getTagValue('Title') || `Propiedad Ref: ${propertyid}`;
    
    // Mapeo preferente de PUEBLOS para Zuzanna: Town (Jávea, Dénia, Calpe...) -> Area -> Location
    const location = getTagValue('Town') || getTagValue('Area') || getTagValue('Location') || 'Costa Blanca';
    
    const isNewDev = getTagValue('NewDevelopment') === '1' || getTagValue('NewDevelopment') === 'true';
    const marketType = isNewDev ? 'New Development' : 'Resale';
    const price = parseFloat(getTagValue('Price')) || 0;
    const beds = parseInt(getTagValue('Bedrooms')) || parseInt(getTagValue('Beds')) || 0;
    const baths = parseInt(getTagValue('Bathrooms')) || parseInt(getTagValue('Baths')) || 0;
    const sqm = parseFloat(getTagValue('Built')) || parseFloat(getTagValue('sqm')) || 0;
    const propertyType = getTagValue('Type') || getTagValue('Subtype') || 'Property';
    const description = getTagValue('Description') || getTagValue('Desc') || '';

    // Extracción limpia e insensible a mayúsculas de imágenes
    let images = [];
    const picturesMatch = block.match(/<Pictures[^>]*>([\s\S]*?)<\/Pictures>/i);
    if (picturesMatch) {
        const urlMatches = picturesMatch[1].match(/<Url[^>]*>([^<]*)<\/Url>/gi);
        if (urlMatches) {
            images = urlMatches.map(m => m.replace(/<\/?Url[^>]*>/gi, '').trim());
        }
    }

    if (images.length === 0) {
        const urlMatches = block.match(/<Url[^>]*>([^<]*)<\/Url>/gi);
        if (urlMatches) {
            images = urlMatches.map(m => m.replace(/<\/?Url[^>]*>/gi, '').trim());
        }
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

// Descarga en memoria y parseo adaptativo
async function fetchAndParseXml() {
    return new Promise((resolve, reject) => {
        const url = "https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2&P_Inc=0";
        
        const req = https.get(url, { 
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': '*/*'
            },
            timeout: 20000 
        }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Resales API respondió con código HTTP: ${res.statusCode}`));
                return;
            }

            let data = '';
            res.setEncoding('utf8');

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                const hasLockMessage = data.includes('previous instance') || 
                                       data.includes('Please wait') || 
                                       data.includes('running');
                if (hasLockMessage) {
                    reject(new Error("RESALES_CONCURRENCY_LOCK"));
                    return;
                }

                // Detección insensible de la etiqueta contenedora
                const tagMatch = data.match(/<(Property_Item|Property|property_item|property)>/i);
                let startTag = '';
                let endTag = '';

                if (tagMatch) {
                    startTag = tagMatch[0];
                    endTag = startTag.replace('<', '</');
                } else {
                    const err = new Error("NO_PROPERTY_TAGS_FOUND");
                    err.rawXmlSnippet = data.substring(0, 500);
                    reject(err);
                    return;
                }

                const properties = [];
                const propertyBlocks = data.split(new RegExp(startTag, 'i'));
                propertyBlocks.shift();

                for (let block of propertyBlocks) {
                    const cleanBlock = block.split(new RegExp(endTag, 'i'))[0];
                    const parsed = parseSingleProperty(cleanBlock);
                    if (parsed) {
                        properties.push(parsed);
                    }
                }

                if (properties.length === 0) {
                    const err = new Error("PARSED_ZERO_PROPERTIES");
                    err.rawXmlSnippet = data.substring(0, 500);
                    reject(err);
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

// Endpoint de Consulta con Encabezados CORS
app.get('/api/properties', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const forceRefresh = req.query.refresh === 'true';

    const isCacheExpired = (Date.now() - lastCachedTime) > CACHE_DURATION;
    let remoteCooldownActive = false;
    let warningMessage = "";
    let noteMessage = "Sincronización de caché activa y saludable.";
    let rawXmlSnippet = "";

    if (!cachedProperties || cachedProperties.length === 0 || isCacheExpired || forceRefresh) {
        console.log("[Proxy] Solicitando actualización de datos a Resales-Online...");
        try {
            const fetchedData = await fetchAndParseXml();
            cachedProperties = fetchedData;
            lastCachedTime = Date.now();
            console.log(`[Proxy] Actualización exitosa. Registros: ${cachedProperties.length}`);
        } catch (error) {
            console.warn("[Proxy] La llamada al proveedor falló. Causa:", error.message);
            remoteCooldownActive = true;
            warningMessage = error.message;

            if (error.rawXmlSnippet) {
                rawXmlSnippet = error.rawXmlSnippet;
            }

            if (!cachedProperties) {
                cachedProperties = [];
            }
        }
    }

    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedItems = cachedProperties.slice(startIndex, endIndex);

    if (cachedProperties.length === 0) {
        noteMessage = "El XML recibido no contenía bloques de propiedades válidos.";
        if (rawXmlSnippet) {
            noteMessage += ` Auditoría XML crudo: ${rawXmlSnippet}`;
        } else if (warningMessage) {
            noteMessage += ` Error de conexión del proveedor: ${warningMessage}`;
        }
    }

    res.json({
        status: remoteCooldownActive ? "ready" : "success",
        properties: paginatedItems,
        total: cachedProperties.length,
        page,
        limit,
        hasMore: endIndex < cachedProperties.length,
        cachedAt: lastCachedTime > 0 ? new Date(lastCachedTime).toISOString() : null,
        remote_cooldown: remoteCooldownActive,
        note: noteMessage,
        warning: warningMessage || null
    });
});

app.listen(PORT, () => {
    console.log(`[Proxy] Escuchando en el puerto ${PORT}`);
});
