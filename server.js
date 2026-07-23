import express from 'express';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3000;

const RESALES_USER = process.env.RESALES_USER || 'RESALES@ININMO7';
const RESALES_PASS = process.env.RESALES_PASS || 'ZWO3WPZ7UU';

// Map en memoria RAM para asegurar unicidad por referencia (_id)
let cachedPropertiesMap = new Map();
let lastCachedTime = 0;
let isSyncing = false;
let hasPerformedCleanLoad = false;
let lastSyncError = "Esperando primera sincronización...";

const PAGE_SIZE = 500; // Tamaño recomendado por Resales-Online

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

app.use(express.json());

function getCleanTagValue(block, tag) {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const match = block.match(regex);
    if (!match) return '';
    const innerContent = match[1].trim();
    const esMatch = innerContent.match(/<es[^>]*>([\s\S]*?)<\/es>/i);
    if (esMatch) return esMatch[1].trim();
    if (innerContent.includes('<') && innerContent.includes('>')) {
        return innerContent.replace(/<[^>]*>/g, '').trim();
    }
    return innerContent;
}

function parseSingleProperty(block) {
    const propertyid = getCleanTagValue(block, 'id') || getCleanTagValue(block, 'Reference') || getCleanTagValue(block, 'PropertyRefNo') || '';
    if (!propertyid) return null;

    const title = getCleanTagValue(block, 'title') || getCleanTagValue(block, 'type') || `Propiedad Ref: ${propertyid}`;
    const location = getCleanTagValue(block, 'town') || getCleanTagValue(block, 'city') || getCleanTagValue(block, 'area') || getCleanTagValue(block, 'location') || 'Costa Blanca';
    const isNewDev = getCleanTagValue(block, 'newdevelopment') === '1' || getCleanTagValue(block, 'newdevelopment') === 'true' || getCleanTagValue(block, 'new_development') === '1';
    const marketType = isNewDev ? 'New Development' : 'Resale';
    const price = parseFloat(getCleanTagValue(block, 'price')) || 0;
    const beds = parseInt(getCleanTagValue(block, 'bedrooms')) || parseInt(getCleanTagValue(block, 'beds')) || 0;
    const baths = parseInt(getCleanTagValue(block, 'bathrooms')) || parseInt(getCleanTagValue(block, 'baths')) || 0;
    const sqm = parseFloat(getCleanTagValue(block, 'built')) || parseFloat(getCleanTagValue(block, 'built_size')) || parseFloat(getCleanTagValue(block, 'sqm')) || 0;
    const propertyType = getCleanTagValue(block, 'type') || 'Property';
    const description = getCleanTagValue(block, 'description') || getCleanTagValue(block, 'desc') || '';

    let uniqueUrls = [];
    const picturesMatch = block.match(/<(?:pictures|images|photos)[^>]*>([\s\S]*?)<\/(?:pictures|images|photos)>/i);
    const searchBlock = picturesMatch ? picturesMatch[1] : block;
    
    const urlTagMatches = searchBlock.match(/<url[^>]*>([^<]*)<\/url>/gi);
    if (urlTagMatches) {
        uniqueUrls = urlTagMatches.map(m => m.replace(/<\/?url[^>]*>/gi, '').trim()).filter(u => u.length > 0);
    } else {
        const rawUrlMatches = searchBlock.match(/https?:\/\/[^\s"<>]+\b/gi) || [];
        uniqueUrls = [...new Set(rawUrlMatches.map(u => u.trim()))];
    }

    uniqueUrls = uniqueUrls.map(u => u.replace(/&amp;/g, '&'));
    uniqueUrls = [...new Set(uniqueUrls)];

    const imagesStr = uniqueUrls.join(',');
    const mainimage = uniqueUrls.length > 0 ? uniqueUrls[0] : 'https://wixideas.wixsite.com/images/placeholder.png';

    return {
        _id: propertyid,
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

function fetchXmlPage(isCleanLoadFirstCall) {
    return new Promise((resolve, reject) => {
        let url = `https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=${encodeURIComponent(RESALES_USER)}&P=${encodeURIComponent(RESALES_PASS)}&FV=2&N=${PAGE_SIZE}`;
        if (isCleanLoadFirstCall) {
            url += '&I=TRUE'; // Forzamos reseteo de puntero incremental
        }

        const options = {
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
            }
        };

        const req = https.get(url, options, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Resales respondió HTTP ${res.statusCode}`));
            }

            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => data += chunk);

            res.on('end', () => {
                if (data.includes('previous instance') || data.includes('Please wait') || data.includes('running')) {
                    return reject(new Error("RESALES_CONCURRENCY_LOCK"));
                }

                let startTag = '';
                let endTag = '';
                const tagMatch = data.match(/<(Property_Item|Property|property_item|property)>/i);
                if (tagMatch) {
                    startTag = tagMatch[0];
                    endTag = startTag.replace('<', '</');
                } else {
                    return resolve([]); // Retorna array vacío si vino la cáscara limpia
                }

                const properties = [];
                const propertyBlocks = data.split(new RegExp(startTag, 'i'));
                propertyBlocks.shift();

                for (let block of propertyBlocks) {
                    const cleanBlock = block.split(new RegExp(endTag, 'i'))[0];
                    const parsed = parseSingleProperty(cleanBlock);
                    if (parsed) properties.push(parsed);
                }

                resolve(properties);
            });

            res.on('error', err => reject(err));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error("TIMEOUT_CONNECTING_TO_RESALES"));
        });

        req.on('error', err => reject(err));
    });
}

async function runSyncCycle() {
    if (isSyncing) return;
    isSyncing = true;

    const isThisACleanLoad = !hasPerformedCleanLoad;
    console.log(`[Proxy Worker] Iniciando ciclo (${isThisACleanLoad ? 'CLEAN LOAD I=TRUE' : 'Incremental'})...`);

    try {
        let pageCount = 0;
        let totalReceived = 0;

        while (pageCount < 20) {
            const isFirstCallOfClean = isThisACleanLoad && pageCount === 0;
            const properties = await fetchXmlPage(isFirstCallOfClean);

            pageCount++;

            if (properties.length === 0) {
                console.log(`[Proxy Worker] Ciclo finalizado. Pagina ${pageCount} devolvió 0 registros.`);
                break;
            }

            for (const p of properties) {
                cachedPropertiesMap.set(p._id, p);
            }

            totalReceived += properties.length;
            console.log(`[Proxy Worker] Pagina ${pageCount}: ${properties.length} propiedades (Acumulado RAM: ${cachedPropertiesMap.size}).`);

            if (properties.length < PAGE_SIZE) break;
        }

        if (cachedPropertiesMap.size > 0) {
            hasPerformedCleanLoad = true;
            lastCachedTime = Date.now();
            lastSyncError = "Sincronizado con éxito";
        } else {
            lastSyncError = "El servidor de España entregó cáscara vacía. Se requiere habilitar Development Parameters en Soporte de Resales.";
        }

    } catch (err) {
        console.warn("[Proxy Worker WARN] Fallo en ciclo de sincronización:", err.message);
        lastSyncError = err.message;
    } finally {
        isSyncing = false;
    }
}

// Bucle en segundo plano cada 2 minutos si la RAM está vacía
setInterval(() => {
    if (cachedPropertiesMap.size === 0) runSyncCycle();
}, 2 * 60 * 1000);

setTimeout(runSyncCycle, 2000);

app.get('/api/properties', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const allItems = Array.from(cachedPropertiesMap.values());

    if (allItems.length === 0) {
        runSyncCycle();
        return res.status(200).json({
            status: "cooling_down",
            properties: [],
            total: 0,
            page,
            limit,
            hasMore: false,
            cachedAt: null,
            note: `El proxy está ejecutando la carga inicial (Clean Load I=TRUE). Estado actual: ${lastSyncError}`
        });
    }

    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedItems = allItems.slice(startIndex, endIndex);

    res.json({
        status: "success",
        properties: paginatedItems,
        total: allItems.length,
        page,
        limit,
        hasMore: endIndex < allItems.length,
        cachedAt: new Date(lastCachedTime).toISOString(),
        note: "Datos servidos desde memoria RAM protegida."
    });
});

app.listen(PORT, () => {
    console.log(`[Proxy] Listo en puerto ${PORT}`);
});
