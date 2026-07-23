import express from 'express';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3000;

// Variables de caché persistente en memoria RAM
let cachedProperties = null;
let lastCachedTime = 0;
const CACHE_DURATION = 4 * 60 * 60 * 1000; // Caché de 4 Horas
const MIN_VALID_CATALOG_SIZE = 10; // Escudo contra lotes degradados

// Middleware de CORS completo
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

app.use(express.json());

// Saneamiento de textos con prioridad en traducción al español <es>
function getCleanTagValue(block, tag) {
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
    const match = block.match(regex);
    if (!match) return '';
    
    const innerContent = match[1].trim();

    // Priorizamos la etiqueta en español si existe traducción multilingüe
    const esMatch = innerContent.match(/<es>([\s\S]*?)<\/es>/i);
    if (esMatch) {
        return esMatch[1].trim();
    }

    // Si tiene otros subnodos HTML pero no es español, limpiamos etiquetas
    if (innerContent.includes('<') && innerContent.includes('>')) {
        return innerContent.replace(/<[^>]*>/g, '').trim();
    }

    return innerContent;
}

// Procesador individual para cada propiedad
function parseSingleProperty(block) {
    const propertyid = getCleanTagValue(block, 'id') || getCleanTagValue(block, 'Reference') || getCleanTagValue(block, 'PropertyRefNo') || '';
    if (!propertyid) return null;

    const title = getCleanTagValue(block, 'title') || getCleanTagValue(block, 'type') || `Propiedad Ref: ${propertyid}`;
    
    // Mapeo geográfico priorizando town o city sobre área o localización
    const location = getCleanTagValue(block, 'town') || 
                     getCleanTagValue(block, 'city') || 
                     getCleanTagValue(block, 'area') || 
                     getCleanTagValue(block, 'location') || 
                     'Costa Blanca';

    const isNewDev = getCleanTagValue(block, 'newdevelopment') === '1' || 
                     getCleanTagValue(block, 'newdevelopment') === 'true' || 
                     getCleanTagValue(block, 'new_development') === '1';
                     
    const marketType = isNewDev ? 'New Development' : 'Resale';
    const price = parseFloat(getCleanTagValue(block, 'price')) || 0;
    const beds = parseInt(getCleanTagValue(block, 'bedrooms')) || parseInt(getCleanTagValue(block, 'beds')) || 0;
    const baths = parseInt(getCleanTagValue(block, 'bathrooms')) || parseInt(getCleanTagValue(block, 'baths')) || 0;
    const sqm = parseFloat(getCleanTagValue(block, 'built')) || parseFloat(getCleanTagValue(block, 'built_size')) || parseFloat(getCleanTagValue(block, 'sqm')) || 0;
    const propertyType = getCleanTagValue(block, 'type') || 'Property';
    const description = getCleanTagValue(block, 'description') || getCleanTagValue(block, 'desc') || '';

    // Extracción de todas las URLs de imágenes válidas
    const imgRegex = /https?:\/\/[^<>\s"']+\.(?:jpg|jpeg|png|webp)/gi;
    const matchedUrls = block.match(imgRegex) || [];
    
    // Deduplicación de URLs de imágenes
    const uniqueUrls = [...new Set(matchedUrls.map(url => url.trim()))];
    
    // images: String separado por comas
    const imagesStr = uniqueUrls.join(',');
    const mainimage = uniqueUrls.length > 0 ? uniqueUrls[0] : 'https://wixideas.wixsite.com/images/placeholder.png';

    return {
        _id: propertyid, // Clave principal de Velo en Wix Studio
        title,
        location,
        marketType,
        price,
        beds,
        baths,
        sqm,
        propertyType,
        description,
        mainimage,
        propertyid,
        images: imagesStr
    };
}

// Descarga en buffer y parseo dinámico
async function fetchAndParseXml() {
    return new Promise((resolve, reject) => {
        // Endpoint V3 Oficial con flag de base de datos completa
        const url = "https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2&P_Inc=0";
        
        // Timeout de conexión a 20 segundos
        const req = https.get(url, { timeout: 20000 }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`API de origen respondió con estado HTTP: ${res.statusCode}`));
                return;
            }

            let data = '';
            res.setEncoding('utf8');

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                // Validación del bloqueo concurrente
                const hasLockMessage = data.includes('previous instance') || 
                                       data.includes('Please wait') || 
                                       data.includes('running');
                if (hasLockMessage) {
                    reject(new Error("RESALES_CONCURRENCY_LOCK"));
                    return;
                }

                // Detección dinámica de la etiqueta contenedora de propiedades
                let startTag = '';
                let endTag = '';

                const tagMatch = data.match(/<(Property_Item|Property|property_item|property)>/i);
                if (tagMatch) {
                    startTag = tagMatch[0];
                    endTag = startTag.replace('<', '</');
                } else {
                    const err = new Error("NO_PROPERTY_TAGS_FOUND");
                    err.rawXmlSnippet = data.substring(0, 1000);
                    reject(err);
                    return;
                }

                const properties = [];
                const propertyBlocks = data.split(startTag);
                propertyBlocks.shift();

                for (let block of propertyBlocks) {
                    const cleanBlock = block.split(endTag)[0];
                    const parsed = parseSingleProperty(cleanBlock);
                    if (parsed) {
                        properties.push(parsed);
                    }
                }

                if (properties.length === 0) {
                    const err = new Error("PARSED_ZERO_PROPERTIES");
                    err.rawXmlSnippet = data.substring(0, 1000);
                    reject(err);
                    return;
                }

                resolve(properties);
            });

            res.on('error', (err) => {
                reject(err);
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error("RESALES_CONNECTION_TIMEOUT"));
        });

        req.on('error', (err) => {
            reject(err);
        });
    });
}

// Ruta API Paginada para Wix Studio con Escudo de Caché
app.get('/api/properties', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const forceRefresh = req.query.refresh === 'true';

    const isCacheExpired = (Date.now() - lastCachedTime) > CACHE_DURATION;
    let remoteCooldownActive = false;
    let warningMessage = null;
    let noteMessage = "Sincronización de caché activa y saludable.";
    let rawXmlSnippet = "";

    if (!cachedProperties || cachedProperties.length === 0 || isCacheExpired || forceRefresh) {
        console.log("[Proxy] Solicitando actualización de datos a Resales-Online...");
        try {
            const fetchedData = await fetchAndParseXml();
            
            // ESCUDO DE PROTECCIÓN DE CACHÉ (Cache Guard)
            if (cachedProperties && cachedProperties.length >= MIN_VALID_CATALOG_SIZE && fetchedData.length < MIN_VALID_CATALOG_SIZE) {
                console.warn(`[Proxy] ESCUDO ACTIVO: Se bloqueó un lote degradado de ${fetchedData.length} elementos para proteger la caché de ${cachedProperties.length} elementos.`);
                remoteCooldownActive = true;
                warningMessage = `Lote externo degradado (${fetchedData.length} propiedades recibidas). Se retiene el catálogo saludable de ${cachedProperties.length} propiedades en la memoria RAM del servidor.`;
                res.setHeader('X-Cache-Status', 'STALE_DUE_TO_DEGRADATION');
            } else {
                cachedProperties = fetchedData;
                lastCachedTime = Date.now();
                console.log(`[Proxy] Caché de RAM actualizada con éxito. Registros válidos: ${cachedProperties.length}`);
                res.setHeader('X-Cache-Status', 'MISS');
            }
        } catch (error) {
            console.warn("[Proxy] La llamada de red externa falló. Causa:", error.message);
            remoteCooldownActive = true;
            warningMessage = error.message;

            if (error.rawXmlSnippet) {
                rawXmlSnippet = error.rawXmlSnippet.substring(0, 500);
            }

            // Inicializamos la caché vacía en caso de que sea la primera ejecución absoluta y falle el origen
            if (!cachedProperties) {
                cachedProperties = [];
            }
            res.setHeader('X-Cache-Status', 'STALE_DUE_TO_ERROR');
        }
    } else {
        res.setHeader('X-Cache-Status', 'HIT');
    }

    // Segmentación y cálculo de paginación sobre el inventario protegido
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedItems = cachedProperties.slice(startIndex, endIndex);

    // Auditoría de logs si el inventario está vacío
    if (cachedProperties.length === 0) {
        noteMessage = "El XML recibido no contenía bloques de propiedades válidos.";
        if (rawXmlSnippet) {
            noteMessage += ` Auditoría XML crudo: ${rawXmlSnippet}`;
        } else if (warningMessage) {
            noteMessage += ` Error de conexión del proveedor: ${warningMessage}`;
        }
    } else if (remoteCooldownActive) {
        noteMessage = `Servidor en enfriamiento o lote externo degradado. ${warningMessage || ""}`;
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
        warning: warningMessage
    });
});

app.listen(PORT, () => {
    console.log(`[Proxy] Servidor corriendo en el puerto ${PORT}`);
});
