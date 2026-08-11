// netlify/functions/buscar-sugerencias.js
// Busca negocios locales sin web en una zona usando datos abiertos de OpenStreetMap
// (geocodificador para la zona + Overpass API para los negocios).
// No requiere ninguna API key ni coste.
//
// v2: más fiable que la versión anterior.
// - Prueba varios servidores de Overpass por si uno está caído o saturado (es habitual).
// - Prueba un geocodificador alternativo (Photon) si Nominatim falla o bloquea la petición
//   (Nominatim a veces bloquea peticiones automáticas desde servidores en la nube).
// - Pone un límite de tiempo a cada llamada para no quedarse colgado y devolver
//   siempre una respuesta clara en vez de un error genérico.

const USER_AGENT = 'AtrioSugerenciasBot/1.0 (uso interno, contacto: atrioemp@gmail.com)';

const GEOCODERS = [
  {
    nombre: 'nominatim',
    url: (zona) => `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(zona)}&format=json&limit=1`,
    parse: (data) => {
      if (!data || !data[0] || !data[0].boundingbox) return null;
      const [south, north, west, east] = data[0].boundingbox.map(Number);
      return { south, north, west, east };
    },
  },
  {
    nombre: 'photon',
    url: (zona) => `https://photon.komoot.io/api/?q=${encodeURIComponent(zona)}&limit=1`,
    parse: (data) => {
      const f = data && data.features && data.features[0];
      if (!f) return null;
      const [lon, lat] = f.geometry.coordinates;
      // Photon no da bounding box, así que construimos uno de ~6km alrededor del punto.
      const delta = 0.03;
      return { south: lat - delta, north: lat + delta, west: lon - delta, east: lon + delta };
    },
  },
];

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

async function fetchConLimite(url, opciones, msTimeout) {
  const controller = new AbortController();
  const aviso = setTimeout(() => controller.abort(), msTimeout);
  try {
    return await fetch(url, { ...opciones, signal: controller.signal });
  } finally {
    clearTimeout(aviso);
  }
}

async function geocodificar(zona) {
  const errores = [];
  for (const geo of GEOCODERS) {
    try {
      const res = await fetchConLimite(geo.url(zona), { headers: { 'User-Agent': USER_AGENT } }, 7000);
      if (!res.ok) { errores.push(`${geo.nombre}: HTTP ${res.status}`); continue; }
      const data = await res.json();
      const bbox = geo.parse(data);
      if (bbox) return bbox;
      errores.push(`${geo.nombre}: sin resultados`);
    } catch (e) {
      errores.push(`${geo.nombre}: ${e.name === 'AbortError' ? 'tardó demasiado' : e.message}`);
    }
  }
  throw new Error(`No se pudo localizar la zona (${errores.join(' · ')})`);
}

async function buscarEnOverpass(query) {
  const errores = [];
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const res = await fetchConLimite(mirror, {
        method: 'POST',
        body: query,
        headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
      }, 9000);
      if (!res.ok) { errores.push(`${mirror}: HTTP ${res.status}`); continue; }
      const data = await res.json();
      return data;
    } catch (e) {
      errores.push(`${mirror}: ${e.name === 'AbortError' ? 'tardó demasiado' : e.message}`);
    }
  }
  throw new Error(`Los servidores de búsqueda están saturados ahora mismo (${errores.join(' · ')}). Prueba de nuevo en un minuto.`);
}

exports.handler = async (event) => {
  try {
    const zona = ((event.queryStringParameters || {}).zona || '').trim();
    if (!zona) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Falta indicar una zona.' }) };
    }

    // 1. Geocodificar la zona a un área de búsqueda (bounding box), con reintento en otro servicio
    let bbox;
    try {
      bbox = await geocodificar(zona);
    } catch (e) {
      return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `No se ha encontrado la zona "${zona}". Prueba a ser más específico (ej: incluye la ciudad). Detalle: ${e.message}` }) };
    }
    const { south, north, west, east } = bbox;

    // 2. Buscar negocios locales dentro de esa zona
    const query = `
      [out:json][timeout:20];
      (
        node["shop"]["name"](${south},${west},${north},${east});
        node["amenity"~"^(restaurant|cafe|bar|fast_food|pub|dentist|doctors|veterinary|hairdresser)$"]["name"](${south},${west},${north},${east});
        node["office"]["name"](${south},${west},${north},${east});
        node["craft"]["name"](${south},${west},${north},${east});
      );
      out body 200;
    `;

    let overpassData;
    try {
      overpassData = await buscarEnOverpass(query);
    } catch (e) {
      return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
    }
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
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Error interno buscando sugerencias: ${err.message}` }) };
  }
};
