import https from 'https';
import http from 'http';
import { URL } from 'url';

function fetchWithRedirects(targetUrl, options, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) {
            reject(new Error("Demasiados redireccionamientos (Límite de 5 excedido)"));
            return;
        }

        const parsedUrl = new URL(targetUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const client = isHttps ? https : http;

        const reqOptions = {
            ...options,
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
        };

        // Si detecta el subdominio de exportación, forzamos bypass por IP y SNI
        if (reqOptions.hostname === 'export.resales-online.com') {
            reqOptions.hostname = '213.162.201.20';
            reqOptions.servername = 'export.resales-online.com';
            reqOptions.headers = reqOptions.headers || {};
            reqOptions.headers['Host'] = 'export.resales-online.com';
        }

        const req = client.request(reqOptions, (res) => {
            // Seguir redirecciones de forma automática e interna en Vercel
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                let redirectUrl = res.headers.location;
                if (!redirectUrl) {
                    reject(new Error(`Redirección ${res.statusCode} sin cabecera Location.`));
                    return;
                }
                if (!redirectUrl.startsWith('http')) {
                    redirectUrl = new URL(redirectUrl, targetUrl).href;
                }
                resolve(fetchWithRedirects(redirectUrl, options, redirectCount + 1));
                return;
            }

            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    data: data
                });
            });
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout de conexión con el servidor de origen'));
        });
        req.end();
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
        res.status(400).json({ error: "Parámetros de credenciales ausentes." });
        return;
    }

    const initialUrl = `https://export.resales-online.com/export/xml/v3/Ventas/Resales?p1=${p1}&p2=${p2}&n=${n}&P_NewDevs=1${i === 'True' ? '&i=True' : ''}`;

    const baseOptions = {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        rejectUnauthorized: false
    };

    try {
        const result = await fetchWithRedirects(initialUrl, baseOptions);
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.status(200).send(result.data); // Siempre devolvemos un 200 limpio con los datos resueltos
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
