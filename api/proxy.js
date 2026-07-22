// api/proxy.js - Vercel Serverless Function (Node 18+ Native Fetch + Decompression)
export default async function handler(req, res) {
    // 1. Configuración de Cabeceras CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        // 2. Extraer parámetros de paginación
        const pageNo = req.query.page || req.query.p_PageNo || req.query.P_PageNo || '1';
        const pageSize = req.query.limit || req.query.p_PageSize || req.query.P_PageSize || '200';

        // 3. Endpoint Oficial Resales Online V3 (Modo Producción Paginado)
        const targetUrl = `https://xmlout.resales-online.com/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2&P_PageNo=${pageNo}&P_PageSize=${pageSize}`;

        // 4. Consumo nativo mediante Fetch (Descompresión gzip automática)
        const response = await fetch(targetUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/xml, text/xml, */*'
            }
        });

        if (!response.ok) {
            return res.status(response.status).json({
                success: false,
                error: `Servidor de España devolvió estatus HTTP ${response.status}`
            });
        }

        const xmlData = await response.text();
        const properties = parseXmlToJSON(xmlData);

        // 5. Retorno limpio en JSON a Wix Studio
        return res.status(200).json({
            success: true,
            page: parseInt(pageNo, 10),
            pageSize: parseInt(pageSize, 10),
            itemsCount: properties.length,
            hasMore: properties.length >= parseInt(pageSize, 10),
            items: properties
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            error: "Error en el pipeline de Vercel: " + error.message
        });
    }
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
