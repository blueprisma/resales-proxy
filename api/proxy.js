import https from 'https';

export default function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // Apunte directo al dominio y credenciales del Feed real de tu captura
    const hostname = "xmlout.resales-online.com";
    const path = "/live/Resales/Export/CreateXMLFeedV3.asp?U=RESALES@ININMO7&P=ZWO3WPZ7UU&FV=2&Sandbox=TRUE";

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
