import express from 'express';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware CORS obligatorio para conexiones desde Wix Studio / Velo
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

// Caché de largo ciclo de vida en la memoria RAM del servidor
let cachedProperties = [];
let lastCachedTime = 0;
let isSyncing = false;
const CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 Horas

// Parser individual con priorización estricta de PUEBLOS (Town > Area > Location)
function parseSingleProperty(block) {
    const getTagValue = (tag) => {
        const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
        const match = block.match(regex);
        return match ? match[1].trim() : '';
    };

    const propertyid = getTagValue('Reference') || getTagValue('PropertyRefNo') || getTagValue('RefNo') || getTagValue('id') || '';
    if (!propertyid) return null;

    const title = getTagValue('Title') || `Propiedad Ref: ${propertyid}`;
    
    // PRIORIZACIÓN DE UBICACIÓN: Town (Jávea, Dénia, Calpe, Altea...) -> Area -> Location
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
        images: images.join(','), // Formato compatible con Wix Data
        description
    };
}

// Descarga en tiempo real por flujo de red con intercepción precoz de bloqueos de 10 min
function fetchAndParseStream() {
    return new Promise((resolve, reject) => {
        // URL Oficial forzando Catálogo Completo sin incremental
        const url = "https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2&P_Inc=0";

        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': '*/*'
            },
            timeout: 8000 // 8 segundos máximo por llamada
        }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Estatus HTTP España: ${res.statusCode}`));
            }

            const properties = [];
            let buffer = '';
            let isLocked = false;

            res.setEncoding('utf8');

            res.on('data', (chunk) => {
                buffer += chunk;

                // Interceptación inmediata de mensaje de bloqueo de concurrencia
                if (buffer.length < 1500) {
                    const hasLockMessage = buffer.includes('previous instance') || 
                                           buffer.includes('Please wait') || 
                                           buffer.includes('running');
                    if (hasLockMessage) {
                        isLocked = true;
                        res.destroy(); // Destrucción inmediata para liberar socket
                        return reject(new Error("RESALES_CONCURRENCY_LOCK"));
                    }
                }

                // Parser de bloques de propiedades sobre el flujo continuo
                let propertyIndex = buffer.indexOf('<Property');
                while (propertyIndex !== -1) {
                    const closingIndex = buffer.indexOf('</Property>', propertyIndex);
                    if (closingIndex === -1) break;

                    const block = buffer.substring(propertyIndex, closingIndex + 11);
                    const parsed = parseSingleProperty(block);
                    if (parsed) {
                        properties.push(parsed);
                    }

                    buffer = buffer.substring(closingIndex + 11);
                    propertyIndex = buffer.indexOf('<Property');
                }
            });

            res.on('end', () => {
                if (isLocked) return;
                resolve(properties);
            });

            res.on('error', (err) => {
                if (!isLocked) reject(err);
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error("RESALES_CONNECTION_TIMEOUT"));
        });

        req.on('error', (err) => reject(err));
    });
}

// Endpoint principal con sistema de respuesta resiliante e inmediata
app.get('/api/properties', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const forceRefresh = req.query.refresh === 'true';

    const isCacheExpired = (Date.now() - lastCachedTime) > CACHE_DURATION;
    let remoteCooldownActive = false;
    let warningMessage = "";

    if (cachedProperties.length === 0 || isCacheExpired || forceRefresh) {
        if (!isSyncing) {
            isSyncing = true;
            console.log("[Proxy] Solicitando actualización de catálogo a España...");

            try {
                const fetchedData = await fetchAndParseStream();
                if (fetchedData && fetchedData.length > 0) {
                    cachedProperties = fetchedData;
                    lastCachedTime = Date.now();
                    console.log(`[Proxy] Actualización exitosa. Total en RAM: ${cachedProperties.length}`);
                }
            } catch (error) {
                console.warn("[Proxy] Llamada a España diferida por Cooldown o Timeout:", error.message);
                remoteCooldownActive = true;
                warningMessage = error.message;
            } finally {
                isSyncing = false;
            }
        }
    }

    // Paginación en memoria RAM sobre los registros disponibles
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedItems = cachedProperties.slice(startIndex, endIndex);

    // Responde SIEMPRE con JSON válido (Jamás bloquea a Wix)
    res.json({
        status: remoteCooldownActive && cachedProperties.length > 0 ? "ready" : "success",
        properties: paginatedItems,
        total: cachedProperties.length,
        page,
        limit,
        hasMore: endIndex < cachedProperties.length,
        cachedAt: lastCachedTime > 0 ? new Date(lastCachedTime).toISOString() : null,
        remote_cooldown: remoteCooldownActive,
        warning: warningMessage || null
    });
});

app.listen(PORT, () => {
    console.log(`[Proxy] Servidor resiliante activo en el puerto ${PORT}`);
});
