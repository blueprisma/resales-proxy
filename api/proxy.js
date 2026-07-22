import https from 'https';

export default function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // 1. Extraer los parámetros de página enviados por Wix Studio
    const pageNo = req.query.p_PageNo || req.query.p_page || req.query.P_PageNo || '1';
    const pageSize = req.query.p_PageSize || req.query.P_PageSize || '200';

    // 2. Dominio y Credenciales reales (Modo LIVE / Producción)
    const hostname = "xmlout.resales-online.com";
    
    // Se elimina Sandbox=TRUE y se inyecta la paginación directa a la API de España
    const finalPath = `/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2&P_PageNo=${pageNo}&P_PageSize=${pageSize}&p_PageNo=${pageNo}&p_PageSize=${pageSize}`;

    const options = {
        hostname: hostname,
        port: 443,
        path: finalPath,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/xml, text/xml, */*'
        },
        timeout: 55000
    };

    return new Promise((resolve) => {
        const httpsReq = https.request(options, (httpsRes) => {
            let data = '';
            httpsRes.setEncoding('utf8');

            httpsRes.on('data', (chunk) => { data += chunk; });
            
            httpsRes.on('end', () => {
                res.setHeader('Content-Type', 'application/xml; charset=utf-8');
                res.status(httpsRes.statusCode).send(data);
                resolve();
            });
        });

        httpsReq.on('error', (error) => {
            res.status(500).json({ error: "Error en la tubería del Feed: " + error.message });
            resolve();
        });

        httpsReq.end();
    });
}
