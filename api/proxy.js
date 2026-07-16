import https from 'https';
import http from 'http';

function nativeRequest(url, hostHeader = null) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/xml, text/xml, */*'
        };
        if (hostHeader) {
            headers['Host'] = hostHeader;
        }

        const req = client.get(url, { headers, timeout: 25000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                resolve(nativeRequest(res.headers.location, hostHeader));
                return;
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({ statusCode: res.statusCode, data: data });
            });
        });
        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout de conexión con el servidor de origen'));
        });
    });
}

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
        res.status(400).json({ error: "Faltan parámetros de credenciales" });
        return;
    }

    // Pipeline de Conexión: Intento 1 usa la IP directa saltándose el DNS. Intento 2 usa el dominio clásico.
    const attempts = [
        { url: `http://213.162.201.20/export/xml/v3/Ventas/Resales?p1=${p1}&p2=${p2}&n=${n}&P_NewDevs=1${i === 'True' ? '&i=True' : ''}`, host: 'export.resales-online.com' },
        { url: `http://export.resales-online.com/export/xml/v3/Ventas/Resales?p1=${p1}&p2=${p2}&n=${n}&P_NewDevs=1${i === 'True' ? '&i=True' : ''}`, host: null }
    ];

    let finalXml = null;
    let success = false;
    let lastError = '';

    for (const attempt of attempts) {
        try {
            const response = await nativeRequest(attempt.url, attempt.host);
            if (response.statusCode === 200 && response.data.includes('<Property>')) {
                finalXml = response.data;
                success = true;
                break;
            } else {
                lastError = `Status: ${response.statusCode}. Contiene datos válidos: ${response.data.includes('<Property>')}`;
            }
        } catch (err) {
            lastError = err.message;
        }
    }

    if (success && finalXml) {
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.status(200).send(finalXml);
    } else {
        res.status(500).json({ error: "Fallo crítico: El proveedor no devolvió registros de propiedades.", detalle: lastError });
    }
}
