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
        res.status(400).json({ error: "Faltan credenciales p1 o p2" });
        return;
    }

    const targetUrl = `http://export.resales-online.com/export/xml/v3/Ventas/Resales?p1=${p1}&p2=${p2}&n=${n}&P_NewDevs=1${i === 'True' ? '&i=True' : ''}`;

    try {
        const response = await fetch(targetUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (VercelProxy/1.0)'
            }
        });

        if (!response.ok) {
            res.status(response.status).send(`Error de Resales: ${response.statusText}`);
            return;
        }

        const xmlData = await response.text();
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.status(200).send(xmlData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
