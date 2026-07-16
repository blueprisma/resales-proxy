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

    const { p1, p2, n = '100', i = 'False' } = req.query;

    if (!p1 || !p2) {
        res.status(400).json({ error: "Parámetros p1 o p2 ausentes." });
        return;
    }

    const ipAddress = "213.162.201.20";
    const hostname = "export.resales-online.com";
    const path = `/export/xml/v3/Ventas/Resales?p1=${p1}&p2=${p2}&n=${n}&P_NewDevs=1${i === 'True' ? '&i=True' : ''}`;

    const options = {
        hostname: ipAddress, // Conexión directa por IP física para saltarse el DNS caído
        port: 443, // Puerto HTTPS estándar
        path: path,
        method: 'GET',
        headers: {
            'Host': hostname, // Cabecera Host requerida para el routing virtual del servidor
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        servername: hostname, // ESTABLECE EL SNI: Esencial para que la negociación SSL no falle al usar IP directa
        rejectUnauthorized: false // Desactiva la restricción por desajuste de certificado de IP
    };

    const httpsReq = https.request(options, (httpsRes) => {
        let data = '';

        httpsRes.on('data', (chunk) => {
            data += chunk;
        });

        httpsRes.on('end', () => {
            res.setHeader('Content-Type', 'application/xml; charset=utf-8');
            res.status(httpsRes.statusCode).send(data);
        });
    });

    httpsReq.on('error', (error) => {
        console.error("Error de conexión en el Proxy Vercel:", error);
        res.status(500).json({ error: error.message });
    });

    httpsReq.end();
}
