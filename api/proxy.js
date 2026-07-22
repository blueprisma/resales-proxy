// api/proxy.js - Vercel Serverless Function (Fast Regex Stream Parser)
import https from 'https';

export default function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const requestedPage = parseInt(req.query.page || '1', 10);
    const pageSize = parseInt(req.query.limit || '200', 10);

    const options = {
        hostname: "xmlout.resales-online.com",
        port: 443,
        path: "/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2",
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept-Encoding': 'gzip, deflate',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: 50000
    };

    return new Promise((resolve) => {
        const httpsReq = https.request(options, (httpsRes) => {
            let rawXml = '';
            
            // Soporte de descompresión automática si el servidor envía gzip
            let stream = httpsRes;
            if (httpsRes.headers['content-encoding'] === 'gzip') {
                const zlib = require('zlib');
                stream = httpsRes.pipe(zlib.createGunzip());
            } else if (httpsRes.headers['content-encoding'] === 'deflate') {
                const zlib = require('zlib');
                stream = httpsRes.pipe(zlib.createInflate());
            }

            stream.setEncoding('utf8');
            stream.on('data', (chunk) => { rawXml += chunk; });

            stream.on('end', () => {
                try {
                    const allItems = extractPropertiesRegex(rawXml);
                    
                    const startIndex = (requestedPage - 1) * pageSize;
                    const endIndex = startIndex + pageSize;
                    const paginatedItems = allItems.slice(startIndex, endIndex);

                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.status(200).json({
                        success: true,
                        page: requestedPage,
                        pageSize: pageSize,
                        totalFound: allItems.length,
                        totalPages: Math.ceil(allItems.length / pageSize),
                        hasMore: endIndex < allItems.length,
                        items: paginatedItems
                    });
                } catch (err) {
                    res.status(500).json({ success: false, error: "Error en parseo: " + err.message });
                }
                resolve();
            });
        });

        httpsReq.on('error', (err) => {
            res.status(500).json({ success: false, error: "Error de conexión con España: " + err.message });
            resolve();
        });

        httpsReq.end();
    });
}

function extractPropertiesRegex(xml) {
    const properties = [];
    if (!xml || typeof xml !== 'string') return properties;

    // Buscar todos los bloques de propiedad sin importar variaciones de mayúsculas
    const propertyRegex = /<(?:Property|property)[^>]*>([\s\S]*?)<\/(?:Property|property)>/gi;
    let match;

    while ((match = propertyRegex.exec(xml)) !== null) {
        const block = match[1];

        const getTag = (tag) => {
            const rx = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
            const m = block.match(rx);
            return m ? m[1].trim() : '';
        };

        const propertyId = getTag('PropertyRefNo') || getTag('Reference') || getTag('id') || getTag('ID');

        if (propertyId) {
            let mainImageUrl = '';
            const urlMatch = block.match(/<url[^>]*>([^<]+)<\/url>/i);
            if (urlMatch) mainImageUrl = urlMatch[1].trim();

            let allImages = [];
            const imagesBlock = block.match(/<images[^>]*>([\s\S]*?)<\/images>/i);
            if (imagesBlock) {
                const urlRx = /<url[^>]*>([^<]+)<\/url>/gi;
                let imgM;
                while ((imgM = urlRx.exec(imagesBlock[1])) !== null) {
                    allImages.push(imgM[1].trim());
                }
            }
            if (allImages.length === 0 && mainImageUrl) allImages.push(mainImageUrl);

            const town = getTag('Location') || getTag('Town') || getTag('Area');
            const region = getTag('Region') || 'Costa Blanca';
            const displayLocation = town ? town : region;

            const price = parseFloat(getTag('Price')) || 0;
            const beds = parseInt(getTag('Bedrooms')) || parseInt(getTag('Beds')) || 0;
            const baths = parseInt(getTag('Bathrooms')) || parseInt(getTag('Baths')) || 0;
            const title = getTag('Title') || `Property Ref: ${propertyId}`;
            const isNewDev = getTag('NewDevelopment') === '1' || getTag('NewDevelopment') === 'true';
            const marketType = isNewDev ? 'New Development' : 'Resale';
            const rawType = getTag('Type') || getTag('PropertyType') || 'Villa';
            const descriptionText = getTag('Description') || '';

            properties.push({
                _id: propertyId,
                title: title,
                location: displayLocation,
                marketType: marketType,
                price: price,
                beds: beds,
                baths: baths,
                mainimage: mainImageUrl,
                propertyid: propertyId,
                sqm: block.match(/<built[^>]*>([^<]+)<\/built>/i) ? parseInt(block.match(/<built[^>]*>([^<]+)<\/built>/i)[1]) : 0,
                propertyType: rawType,
                images: allImages.join(','),
                description: descriptionText
            });
        }
    }

    return properties;
}
