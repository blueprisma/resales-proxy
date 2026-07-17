import https from 'https';

export default function handler(req, res) {
    // Cabeceras de control CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { p1, p2, n = '50', i = 'False' } = req.query;

    if (!p1 || !p2) {
        res.status(400).json({ error: "Parámetros p1 o p2 ausentes." });
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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        servername: hostname,
        rejectUnauthorized: false
    };

    const httpsReq = https.request(options, (httpsRes) => {
        // Indicamos que transferiremos un stream XML directo
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.status(httpsRes.statusCode);
        
        // Canalización directa (pipe) sin almacenamiento intermedio en Vercel
        httpsRes.pipe(res);
    });

    httpsReq.on('error', (error) => {
        console.error("Error en streaming del Proxy Vercel:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    });

    httpsReq.end();
}
