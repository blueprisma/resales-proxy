import https from 'https';
import http from 'http';

function nativeRequest(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/xml, text/xml, */*'
            },
            timeout: 20000
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                resolve(nativeRequest(res.headers.location));
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
            reject(new Error('Timeout con el servidor de origen'));
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

    // Matriz de contingencia: Si falla el DNS de export, conmuta automáticamente a www o IP directa
    const targetEndpoints = [
        `https://www.resales-online.com/export/xml/v3/Ventas/Resales?p1=${p1}&p2=${p2}&n=${n}&P_NewDevs=1${i === 'True' ? '&i=True' : ''}`,
        `https://export.resales-online.com/export/xml/v3/Ventas/Resales?p1=${p1}&p2=${p2}&n=${n}&P_NewDevs=1${i === 'True' ? '&i=True' : ''}`
    ];

    let xmlData = null;
    let isSuccessful = false;
    let logError = '';

    for (const url of targetEndpoints) {
        try {
            const response = await nativeRequest(url);
            if (response.statusCode === 200) {
                xmlData = response.data;
                isSuccessful = true;
                break;
            } else {
                logError = `Estado HTTP devuelto: ${response.statusCode}`;
            }
        } catch (err) {
            logError = `Error de resolución de pasarela: ${err.message}`;
        }
    }

    if (isSuccessful && xmlData) {
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.status(200).send(xmlData);
    } else {
        res.status(500).json({ error: "Fallo crítico de conexión externa", detalles: logError });
    }
}
