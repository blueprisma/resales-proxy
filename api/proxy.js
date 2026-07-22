import https from 'https';

export default function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // 1. Dominio y Credenciales reales tomadas de tu captura activa
    const hostname = "xmlout.resales-online.com";
    const basePath = "/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2&Sandbox=TRUE";

    // 2. Extraer dinámicamente los parámetros de paginación enviados por Wix (p_PageNo, p_PageSize)
    const incomingParams = new URLSearchParams(req.query).toString();

    // 3. Concatenar los parámetros de página a la URL oficial de España
    const finalPath = incomingParams ? `${basePath}&${incomingParams}` : basePath;

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
