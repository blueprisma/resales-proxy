import express from 'express';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3000;

// Estados de sincronización y caché en RAM
let cachedProperties = null;
let lastCachedTime = 0;
let syncInProgress = false;
let downloadProgressText = "Servidor inicializado. Esperando disparo de sincronización.";

const CACHE_DURATION = 4 * 60 * 60 * 1000; // Ciclo de vida de caché (4 Horas)
const MIN_VALID_CATALOG_SIZE = 30; // Escudo protector contra degradación de catálogo

// Auxiliar para pausas asíncronas
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

// Procesador de inmueble individual
function parseSingleProperty(block) {
    const propertyid = getCleanTagValue(block, 'id') || getCleanTagValue(block, 'Reference') || getCleanTagValue(block, 'PropertyRefNo') || '';
    if (!propertyid) return null;

    const title = getCleanTagValue(block, 'title') || getCleanTagValue(block, 'type') || `Propiedad Ref: ${propertyid}`;
    
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
    const imgRegex = /https?:\/\/[^<>\s"']+(?:\.(?:jpg|jpeg|png|webp|gif)|ShowFeedImage\.asp\?[^<>\s"']+)/gi;
    const matchedUrls = block.match(imgRegex) || [];
    const uniqueUrls = [...new Set(matchedUrls.map(url => url.trim()))];
    
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

// Descarga en buffer y parseo de un lote único con timeout de 20s
async function fetchAndParseSingleUrl(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 20000 }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Resales API respondió con código de estado HTTP: ${res.statusCode}`));
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
                propertyBlocks.shift(); // Descartamos la cabecera del XML

                for (let block of propertyBlocks) {
                    const cleanBlock = block.split(endTag)[0];
                    const parsed = parseSingleProperty(cleanBlock);
                    if (parsed) {
                        properties.push(parsed);
                    }
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

// Bucle asíncrono con control de concurrencia y pausa de silencio de 45 segundos
async function runCooldownResilientSync() {
    if (syncInProgress) {
        console.log("[Sync] Sincronización ya está en ejecución.");
        return;
    }

    syncInProgress = true;
    downloadProgressText = "Iniciando descarga y preparando puntero...";
    console.log("[Sync] Iniciando proceso de descarga asíncrona...");

    const tempPropertiesMap = new Map();
    const batchSize = 50;
    const baseUrl = "https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2&P_Inc=0";
    
    let pageAttempt = 1;
    let fetchMore = true;

    try {
        // PASO 1: Enviar &i=True&n=50 una única vez para inicializar el puntero
        console.log("[Sync] Paso 1: Enviando instrucción de Carga Limpia (&i=True)...");
        const initUrl = `${baseUrl}&n=${batchSize}&i=True`;
        
        let batchProperties = [];
        try {
            batchProperties = await fetchAndParseSingleUrl(initUrl);
            console.log(`[Sync] Conexión establecida con éxito en primer intento. Recibidos: ${batchProperties.length}`);
        } catch (initError) {
            if (initError.message === "RESALES_CONCURRENCY_LOCK") {
                // España está generando el XML. Entramos en silencio total de 45 segundos
                downloadProgressText = "Bloqueo por concurrencia detectado. Entrando en pausa de silencio de 45 segundos...";
                console.warn(`[Sync] ${downloadProgressText}`);
                await wait(45000);
                
                // Paso 2: Reintentar el primer lote SIN enviar &i=True
                downloadProgressText = "Pausa finalizada. Recuperando primer lote sin instrucción de reinicio...";
                console.log(`[Sync] ${downloadProgressText}`);
                const retryUrl = `${baseUrl}&n=${batchSize}`;
                batchProperties = await fetchAndParseSingleUrl(retryUrl);
                console.log(`[Sync] Recuperación exitosa del primer lote tras pausa. Recibidos: ${batchProperties.length}`);
            } else {
                throw initError;
            }
        }

        // Acumulamos el primer lote si contiene registros
        if (batchProperties && batchProperties.length > 0) {
            for (const prop of batchProperties) {
                tempPropertiesMap.set(prop._id, prop);
            }
            downloadProgressText = `Descargadas ${tempPropertiesMap.size} propiedades de España (Lote 1 completado)...`;
            console.log(`[Sync] ${downloadProgressText}`);
            
            if (batchProperties.length < batchSize) {
                fetchMore = false; // El catálogo tiene menos de 50 registros
            } else {
                pageAttempt = 2;
            }
        } else {
            fetchMore = false; // Lote inicial vacío
        }

        // PASO 3: Descarga secuencial por micro-lotes de 50 en 50 sin &i=True
        while (fetchMore) {
            const nextUrl = `${baseUrl}&n=${batchSize}`;
            console.log(`[Sync] Descargando lote secuencial ${pageAttempt}...`);
            
            try {
                const nextProperties = await fetchAndParseSingleUrl(nextUrl);

                if (nextProperties && nextProperties.length > 0) {
                    for (const prop of nextProperties) {
                        tempPropertiesMap.set(prop._id, prop);
                    }

                    downloadProgressText = `Descargadas ${tempPropertiesMap.size} propiedades de España (Lote ${pageAttempt} completado)...`;
                    console.log(`[Sync] ${downloadProgressText}`);

                    if (nextProperties.length < batchSize) {
                        fetchMore = false;
                    } else {
                        pageAttempt++;
                        await wait(150); // Breve retardo preventivo para proteger el canal de red
                    }
                } else {
                    fetchMore = false;
                }
            } catch (loopError) {
                // Control del final del puntero del feed
                if (loopError.message === "PARSED_ZERO_PROPERTIES" || loopError.message === "NO_PROPERTY_TAGS_FOUND") {
                    console.log("[Sync] El puntero del feed secuencial alcanzó el final del catálogo.");
                    fetchMore = false;
                } else {
                    throw loopError;
                }
            }
        }

        // PASO 4: Consolidación y Escudo de Protección de Caché
        if (tempPropertiesMap.size >= MIN_VALID_CATALOG_SIZE) {
            cachedProperties = Array.from(tempPropertiesMap.values());
            lastCachedTime = Date.now();
            console.log(`[Sync] Sincronización completada con éxito. Catálogo en RAM: ${cachedProperties.length}`);
            downloadProgressText = "Sincronización de caché activa y saludable.";
        } else {
            throw new Error(`Volumen de datos insuficiente (${tempPropertiesMap.size} recibidos). Reteniendo caché previa.`);
        }

    } catch (error) {
        console.error("[Sync] Fallo crítico durante el proceso de sincronización:", error.message);
        downloadProgressText = `Fallo en sincronización: ${error.message}`;
    } finally {
        syncInProgress = false;
    }
}

// 1. DESACOPLAMIENTO TOTAL: Lectura exclusiva desde memoria RAM
app.get('/api/properties', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;

    // Si la RAM está vacía (Cold Start), responde con cooling_down y el progreso en note
    if (!cachedProperties || cachedProperties.length === 0) {
        return res.status(200).json({
            status: "cooling_down",
            properties: [],
            total: 0,
            page,
            limit,
            hasMore: false,
            cachedAt: null,
            remote_cooldown: true,
            note: downloadProgressText,
            warning: null
        });
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
        cachedAt: lastCachedTime > 0 ? new Date(lastCachedTime).toISOString() : null,
        remote_cooldown: syncInProgress,
        note: downloadProgressText,
        warning: null
    });
});

// 2. DISPARO DE SINCRONIZACIÓN DEDICADO
app.get('/api/trigger-sync', (req, res) => {
    if (syncInProgress) {
        return res.status(200).json({
            status: "in_progress",
            note: "La sincronización ya se encuentra ejecutándose en segundo plano."
        });
    }

    // Ejecución asíncrona de fondo para liberar de inmediato la conexión HTTP
    runCooldownResilientSync();

    res.status(200).json({
        status: "triggered",
        note: "Sincronización asíncrona iniciada. Consulta el progreso en /api/properties."
    });
});

app.listen(PORT, () => {
    console.log(`[Proxy] Servidor corriendo en el puerto ${PORT}`);
});

// Disparo inicial automático a los 10 segundos de encendido para precalentar la RAM
setTimeout(runCooldownResilientSync, 10000);
