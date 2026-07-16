import https from 'https';

function nativeRequest(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/xml, text/xml, */*'
            },
            timeout: 30000
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
            reject(new Error('Timeout de espera con el servidor de origen'));
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
        res.status(400).json({ error: "Faltan parámetros obligatorios de credenciales" });
        return;
    }

    const targetUrl = `https://export.resales-online.com/export/xml/v3/Ventas/Resales?p1=${p1}&p2=${p2}&n=${n}&P_NewDevs=1${i === 'True' ? '&i=True' : ''}`;

    try {
        const response = await nativeRequest(targetUrl);
        
        // Si el servidor de origen responde con HTML en lugar de XML debido a credenciales inválidas
        if (response.data.trim().toLowerCase().startsWith('<!doctype html') || response.data.includes('<html')) {
            res.status(403).json({ 
                error: "RECHAZO_DE_CREDENCIALES: El servidor de España denegó el acceso y desvió la llamada a su web pública. Las claves p1 o p2 configuradas en Wix son incorrectas, están inactivas o vacías."
            });
            return;
        }

        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.status(200).send(response.data);
    } catch (err) {
        res.status(500).json({ error: "Error interno en el puente proxy", detalle: err.message });
    }
}
