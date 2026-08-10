// netlify/functions/listar-solicitudes.js
// Devuelve las solicitudes guardadas en Airtable para que el panel "Clientes Atrio" las muestre.
// Requiere la variable de entorno AIRTABLE_API_KEY configurada en Netlify
// (Site settings > Environment variables), con un Personal Access Token de Airtable
// que tenga permiso de lectura sobre la base "Atrio - Solicitudes".

const AIRTABLE_BASE_ID = 'appvz4WdS2j5L0RUI';
const AIRTABLE_TABLE_ID = 'tblLzVga6soadDhuW';

exports.handler = async () => {
  try {
    const res = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}?sort[0][field]=Fecha&sort[0][direction]=desc`,
      {
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
        },
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error('Error de Airtable:', errText);
      return { statusCode: 502, body: JSON.stringify({ records: [] }) };
    }

    const data = await res.json();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: data.records || [] }),
    };
  } catch (err) {
    console.error('Error en listar-solicitudes:', err);
    return { statusCode: 500, body: JSON.stringify({ records: [] }) };
  }
};
