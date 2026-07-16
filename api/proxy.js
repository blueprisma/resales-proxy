import https from 'https';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { p1, p2, n = '100', i = 'False' } = req.query;

    if (!p1 || !p2) {
        res.status(400).json({ error: "Parámetros de credenciales ausentes." });
        return;
    }

    // Ruta optimizada a través de la central web principal del proveedor para máxima estabilidad DNS
    const targetUrl = `https://www.resales-online.com/export/xml/v3/Ventas/Resales?p1=${p1}&p2=${p2}&n=${n}&P_NewDevs=1${i === 'True' ? '&i=True' : ''}`;

    const requestOptions = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'application/xml, text/xml, */*'
        },
        timeout: 12000
    };

    const httpsReq = https.get(targetUrl, requestOptions, (httpsRes) => {
        let data = '';
        httpsRes.setEncoding('utf8');

        httpsRes.on('data', (chunk) => {
            data += chunk;
        });

        httpsRes.on('end', () => {
            res.setHeader('Content-Type', 'application/xml; charset=utf-8');
            res.status(httpsRes.statusCode).send(data);
        });
    });

    httpsReq.on('error', (error) => {
        res.status(500).json({ error: "Fallo de comunicación con la central pública del proveedor.", detalle: error.message });
    });

    httpsReq.on('timeout', () => {
        httpsReq.destroy();
        res.status(504).json({ error: "El servidor de origen tardó demasiado tiempo en procesar los registros." });
    });

    httpsReq.end();
}
