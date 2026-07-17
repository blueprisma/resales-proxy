import https from 'https';

export default function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { p1, p2, n = '20', i = 'False' } = req.query;

    if (!p1 || !p2) {
        res.status(400).json({ error: "Parámetros de credenciales ausentes." });
        return;
    }

    const ipAddress = "213.162.201.20";
    const hostname = "export.resales-online.com";
    const path = `/export/xml/v3/Ventas/Resales?p1=${p1}&p2=${p2}&n=${n}&P_NewDevs=1${i === 'True' ? '&i=True' : ''}`;

    const options = {
        hostname: ipAddress,
        port: 443,
        path: path,
        method: 'GET',
        headers: {
            'Host': hostname,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        },
        servername: hostname,
        rejectUnauthorized: false,
        timeout: 25000
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
            res.status(500).json({ error: error.message });
            resolve();
        });

        httpsReq.on('timeout', () => {
            httpsReq.destroy();
            res.status(504).json({ error: "Timeout de ráfaga con España" });
            resolve();
        });

        httpsReq.end();
    });
}
