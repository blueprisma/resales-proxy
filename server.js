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

// Configuración de caché interna en memoria
let cachedProperties = null;
let lastCachedTime = 0;
const CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 Horas de ciclo de vida de la caché

// Saneamiento y mapeo robusto de tags XML a JSON para Wix Studio
function parseSingleProperty(block) {
    const getTagValue = (tag) => {
        const regex = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i');
        const match = block.match(regex);
        return match ? match[1].trim() : '';
    };

    // Clave primaria única para la base de datos de Wix
    const propertyid = getTagValue('Reference') || getTagValue('PropertyRefNo') || getTagValue('RefNo') || '';
    if (!propertyid) return null;

    const title = getTagValue('Title') || `Propiedad Ref: ${propertyid}`;
    const location = getTagValue('Area') || getTagValue('Location') || getTagValue('Town') || 'Alicante';
    const isNewDev = getTagValue('NewDevelopment') === '1' || getTagValue('NewDevelopment') === 'true';
    const marketType = isNewDev ? 'New Development' : 'Resale';
    const price = parseFloat(getTagValue('Price')) || 0;
    const beds = parseInt(getTagValue('Bedrooms')) || parseInt(getTagValue('Beds')) || 0;
    const baths = parseInt(getTagValue('Bathrooms')) || parseInt(getTagValue('Baths')) || 0;
    const sqm = parseFloat(getTagValue('Built')) || parseFloat(getTagValue('sqm')) || 0;
    const propertyType = getTagValue('Type') || 'Property';
    const description = getTagValue('Description') || getTagValue('Desc') || '';

    // Extracción limpia de la lista de imágenes
    let images = [];
    const picturesMatch = block.match(/<Pictures>([\s\S]*?)<\/Pictures>/i);
    if (picturesMatch) {
        const urlMatches = picturesMatch[1].match(/<Url>([^<]*)<\/Url>/gi);
        if (urlMatches) {
            images = urlMatches.map(m => m.replace(/<\/?Url>/gi, '').trim());
        }
    }

    if (images.length === 0) {
        const urlMatches = block.match(/<Url>([^<]*)<\/Url>/gi);
        if (urlMatches) {
            images = urlMatches.map(m => m.replace(/<\/?Url>/gi, '').trim());
        }
    }

    const mainimage = images.length > 0 ? images[0] : 'https://wixideas.wixsite.com/images/placeholder.png';

    return {
        _id: propertyid, // _id requerido en WixData para bulkSave
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
        images,
        description
    };
}

// Descarga en formato streaming interceptando bloqueos por concurrencia
async function fetchAndParseXmlStream() {
    return new Promise((resolve, reject) => {
        const url = "https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2";
        
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`El servidor de origen respondió con código HTTP: ${res.statusCode}`));
                return;
            }

            const properties = [];
            let buffer = '';
            let isLocked = false;

            res.setEncoding('utf8');

            res.on('data', (chunk) => {
                buffer += chunk;
                
                // Defensa temprana: Detecta si la respuesta inicial contiene el bloqueo de 10 minutos
                if (buffer.length < 1500) {
                    const hasLockMessage = buffer.includes('previous instance') || 
                                           buffer.includes('Please wait') || 
                                           buffer.includes('running');
                    
                    if (hasLockMessage) {
                        isLocked = true;
                        res.destroy(); // Destruye el canal de inmediato para liberar RAM
                        reject(new Error("RESALES_CONCURRENCY_LOCK"));
                        return;
                    }
                }

                let propertyIndex = buffer.indexOf('<Property>');

                while (propertyIndex !== -1) {
                    const closingIndex = buffer.indexOf('</Property>', propertyIndex);
                    if (closingIndex === -1) {
                        break; 
                    }

                    const block = buffer.substring(propertyIndex + 10, closingIndex);
                    const parsed = parseSingleProperty(block);
                    
                    if (parsed) {
                        properties.push(parsed);
                    }

                    buffer = buffer.substring(closingIndex + 11);
                    propertyIndex = buffer.indexOf('<Property>');
                }
            });

            res.on('end', () => {
                if (isLocked) return;
                
                if (properties.length === 0 && (buffer.includes('feed_version') || buffer.includes('resalesonline'))) {
                    reject(new Error("RESALES_EMPTY_RESPONSE_LOCK"));
                    return;
                }
                
                resolve(properties);
            });

            res.on('error', (err) => {
                if (!isLocked) reject(err);
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

// Rutas de la API
app.get('/api/properties', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const forceRefresh = req.query.refresh === 'true';

    try {
        const isCacheExpired = (Date.now() - lastCachedTime) > CACHE_DURATION;

        if (!cachedProperties || isCacheExpired || forceRefresh) {
            console.log("[Proxy] Solicitando actualización de datos a Resales-Online...");
            
            try {
                const fetchedData = await fetchAndParseXmlStream();
                cachedProperties = fetchedData;
                lastCachedTime = Date.now();
                console.log(`[Proxy] Caché de memoria actualizada. Registros: ${cachedProperties.length}`);
                res.setHeader('X-Cache-Status', 'MISS');
            } catch (streamError) {
                console.warn("[Proxy] Fallo en la llamada directa al proveedor:", streamError.message);
                
                if (cachedProperties && cachedProperties.length > 0) {
                    console.log("[Proxy] Sirviendo caché persistente anterior para evitar desconexión.");
                    res.setHeader('X-Cache-Status', 'STALE_DUE_TO_LOCK');
                    res.setHeader('X-Cache-Warning', streamError.message);
                } else {
                    if (streamError.message === "RESALES_CONCURRENCY_LOCK" || streamError.message === "RESALES_EMPTY_RESPONSE_LOCK") {
                        return res.status(429).json({
                            status: "error",
                            code: "PROVIDER_LOCKED",
                            message: "Resales-Online está procesando el XML en segundo plano o el feed está bloqueado temporalmente. Por favor, espere 10 minutos."
                        });
                    }
                    throw streamError;
                }
            }
        } else {
            res.setHeader('X-Cache-Status', 'HIT');
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
            cachedAt: new Date(lastCachedTime).toISOString()
        });

    } catch (error) {
        console.error("[Proxy Error] Fallo crítico:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`[Proxy] Servidor corriendo en puerto ${PORT}`);
});
