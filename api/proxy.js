import https from 'https';
import http from 'http';

function nativeRequest(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (VercelProxy/1.0)',
                'Accept': 'application/xml, text/xml, */*'
            },
            timeout: 15000 // 15 segundos máximo de espera
        }, (res) => {
            // Manejo automático de redirecciones si existieran
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                resolve(nativeRequest(res.headers.location));
                return;
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    data: data
                });
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Tiempo de espera agotado con Resales-Online'));
        });
    });
}

export default async function handler(req, res) {
    // Cabeceras universales de CORS para evitar cualquier bloqueo en el navegador
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { p1, p2, n = '100', i = 'False' } = req.query;

    if (!p1 || !p2) {
        res.status(400).json({ error: "Faltan credenciales p1 o p2" });
        return;
    }

    // Preparamos URLs seguras e inseguras para el auto-fallback
    const targetUrlHttps = `https://export.resales-online.com/export/xml/v3/Ventas/Resales?p1=${p1}&p2=${p2}&n=${n}&P_NewDevs=1${i === 'True' ? '&i=True' : ''}`;
    const targetUrlHttp = `http://export.resales-online.com/export/xml/v3/Ventas/Resales?p1=${p1}&p2=${p2}&n=${n}&P_NewDevs=1${i === 'True' ? '&i=True' : ''}`;

    try {
        // Intento 1: Conexión segura moderna (HTTPS)
        const result = await nativeRequest(targetUrlHttps);
        if (result.statusCode === 200) {
            res.setHeader('Content-Type', 'application/xml; charset=utf-8');
            res.status(200).send(result.data);
            return;
        }
        throw new Error(`HTTPS devolvió estado ${result.statusCode}`);
    } catch (httpsError) {
        try {
            // Intento 2 (Fallback): Conexión tradicional (HTTP) si falla la seguridad SSL del destino
            const resultHttp = await nativeRequest(targetUrlHttp);
            if (resultHttp.statusCode === 200) {
                res.setHeader('Content-Type', 'application/xml; charset=utf-8');
                res.status(200).send(resultHttp.data);
                return;
            }
            res.status(resultHttp.statusCode).send(`Error HTTP: ${resultHttp.statusCode}`);
        } catch (httpError) {
            res.status(500).json({ 
                error: "Fallo de conexión total con Resales-Online.", 
                detalles: {
                    https: httpsError.message,
                    http: httpError.message
                }
            });
        }
    }
}
