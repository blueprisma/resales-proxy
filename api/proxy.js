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

    const hostname = "xmlout.resales-online.com";
    const path = "/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2";

    const options = {
        hostname: hostname,
        port: 443,
        path: path,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/xml, text/xml, */*'
        },
        timeout: 55000
    };

    return new Promise((resolve) => {
        const httpsReq = https.request(options, (httpsRes) => {
            let xmlData = '';
            httpsRes.setEncoding('utf8');

            httpsRes.on('data', (chunk) => { xmlData += chunk; });
            
            httpsRes.on('end', () => {
                try {
                    const properties = parseXmlToJSON(xmlData);
                    
                    // Paginación interna de alto rendimiento en Vercel
                    const startIndex = (requestedPage - 1) * pageSize;
                    const endIndex = startIndex + pageSize;
                    const paginatedItems = properties.slice(startIndex, endIndex);

                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.status(200).json({
                        success: true,
                        page: requestedPage,
                        pageSize: pageSize,
                        totalProperties: properties.length,
                        totalPages: Math.ceil(properties.length / pageSize),
                        hasMore: endIndex < properties.length,
                        items: paginatedItems
                    });
                } catch (err) {
                    res.status(500).json({ success: false, error: "Error al parsear el feed: " + err.message });
                }
                resolve();
            });
        });

        httpsReq.on('error', (error) => {
            res.status(500).json({ success: false, error: "Error en la tubería del Feed: " + error.message });
            resolve();
        });

        httpsReq.end();
    });
}

function parseXmlToJSON(xmlString) {
    const properties = [];
    if (!xmlString || typeof xmlString !== 'string') return properties;

    const cleanXml = xmlString.replace(/<property>/gi, '<Property>').replace(/<\/property>/gi, '</Property>');
    if (!cleanXml.includes('<Property>')) return properties;

    const propertyBlocks = cleanXml.split('<Property>');
    propertyBlocks.shift(); 

    for (let block of propertyBlocks) {
        block = block.split('</Property>')[0];
        
        const getTagValue = (tag) => {
            const regex = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i');
            const match = block.match(regex);
            return match ? match[1].trim() : '';
        };

        const propertyId = getTagValue('PropertyRefNo') || getTagValue('Reference') || getTagValue('id') || '';

        let mainImageUrl = '';
        const urlMatch = block.match(/<url>([^<]+)<\/url>/i);
        if (urlMatch) {
            mainImageUrl = urlMatch[1].trim();
        }

        let allImages = [];
        const imagesBlock = block.match(/<images>([\s\S]*?)<\/images>/i);
        if (imagesBlock) {
            const urlRegex = /<url>([^<]+)<\/url>/gi;
            let imgMatch;
            while ((imgMatch = urlRegex.exec(imagesBlock[1])) !== null) {
                allImages.push(imgMatch[1].trim());
            }
        }
        if (allImages.length === 0 && mainImageUrl) {
            allImages.push(mainImageUrl);
        }

        const town = getTagValue('Location') || getTagValue('Town') || getTagValue('Area');
        const region = getTagValue('Region') || 'Costa Blanca';
        const displayLocation = town ? `${town}` : region;

        const price = parseFloat(getTagValue('Price')) || 0;
        const beds = parseInt(getTagValue('Bedrooms')) || parseInt(getTagValue('Beds')) || 0;
        const baths = parseInt(getTagValue('Bathrooms')) || parseInt(getTagValue('Baths')) || 0;
        const title = getTagValue('Title') || `Property Ref: ${propertyId}`;
        const isNewDev = getTagValue('NewDevelopment') === '1' || getTagValue('NewDevelopment') === 'true';
        const marketType = isNewDev ? 'New Development' : 'Resale';
        const rawType = getTagValue('Type') || getTagValue('PropertyType') || 'Villa';
        const descriptionText = getTagValue('Description') || '';

        if (propertyId) {
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
                sqm: block.match(/<built>([^<]+)<\/built>/i) ? parseInt(block.match(/<built>([^<]+)<\/built>/i)[1]) : 0,
                propertyType: rawType,
                images: allImages.join(','),
                description: descriptionText
            });
        }
    }
    return properties;
}
