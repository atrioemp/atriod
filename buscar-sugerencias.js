// netlify/functions/buscar-sugerencias.js
// Busca negocios locales sin web en una zona usando datos abiertos de OpenStreetMap
// (Nominatim para geocodificar la zona + Overpass API para los negocios).
// No requiere ninguna API key ni coste.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'AtrioSugerenciasBot/1.0 (uso interno, contacto: atrioemp@gmail.com)';

exports.handler = async (event) => {
  try {
    const zona = ((event.queryStringParameters || {}).zona || '').trim();
    if (!zona) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Falta indicar una zona.' }) };
    }

    // 1. Geocodificar la zona a un área de búsqueda (bounding box)
    const geoRes = await fetch(`${NOMINATIM_URL}?q=${encodeURIComponent(zona)}&format=json&limit=1`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!geoRes.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo localizar esa zona ahora mismo.' }) };
    }
    const geoData = await geoRes.json();
    if (!geoData || !geoData[0] || !geoData[0].boundingbox) {
      return { statusCode: 404, body: JSON.stringify({ error: `No se ha encontrado la zona "${zona}". Prueba a ser más específico (ej: incluye la ciudad).` }) };
    }
    const [south, north, west, east] = geoData[0].boundingbox.map(Number);

    // 2. Buscar negocios locales dentro de esa zona
    const query = `
      [out:json][timeout:25];
      (
        node["shop"]["name"](${south},${west},${north},${east});
        node["amenity"~"^(restaurant|cafe|bar|fast_food|pub|dentist|doctors|veterinary|hairdresser)$"]["name"](${south},${west},${north},${east});
        node["office"]["name"](${south},${west},${north},${east});
        node["craft"]["name"](${south},${west},${north},${east});
      );
      out body 200;
    `;
    const overpassRes = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: query,
      headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
    });
    if (!overpassRes.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'El servicio de búsqueda está saturado ahora mismo. Prueba de nuevo en un minuto.' }) };
    }
    const overpassData = await overpassRes.json();
    const elementos = overpassData.elements || [];

    // 3. Quedarnos solo con los que no tienen web registrada
    const sinWeb = elementos.filter((el) => {
      const tags = el.tags || {};
      return !tags.website && !tags['contact:website'] && !tags['website:menu'];
    });

    // 4. Formatear al mismo formato que usa el panel
    const TIPO_LEGIBLE = {
      restaurant: 'Restaurante', cafe: 'Cafetería', bar: 'Bar', fast_food: 'Comida rápida',
      pub: 'Bar/Pub', dentist: 'Dentista', doctors: 'Consulta médica', veterinary: 'Veterinaria',
      hairdresser: 'Peluquería',
    };
    const sugerencias = sinWeb.slice(0, 30).map((el) => {
      const tags = el.tags || {};
      const tipoBruto = tags.shop || tags.amenity || tags.office || tags.craft || '';
      const tipo = TIPO_LEGIBLE[tipoBruto] || (tipoBruto ? tipoBruto.charAt(0).toUpperCase() + tipoBruto.slice(1) : 'Negocio local');
      const direccion = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
      const notasPartes = [];
      if (direccion) notasPartes.push(direccion);
      if (tags['addr:city']) notasPartes.push(tags['addr:city']);
      if (!direccion && !tags['addr:city']) notasPartes.push(`Zona: ${zona}`);
      return {
        id: `osm-${el.id}`,
        negocio: tags.name,
        tipo,
        contacto: tags.phone || tags['contact:phone'] || '',
        notas: notasPartes.join(', '),
      };
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sugerencias, zona, total: sugerencias.length }),
    };
  } catch (err) {
    console.error('Error en buscar-sugerencias:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Error interno buscando sugerencias.' }) };
  }
};
