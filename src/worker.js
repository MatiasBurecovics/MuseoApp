export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS para todas las rutas
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      });
    }

    // ---- HEALTH CHECK (para mantener activo) ----
    if (path === "/" && request.method === "GET") {
      return new Response(JSON.stringify({ status: "ok", servidor: "museo-worker activo" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // ---- RUTA GODOT: clasificar imagen ----
    if (path === "/clasificar" && request.method === "POST") {
      return await clasificarImagen(request, env);
    }

    // ---- RUTAS WEB: inventario ----
    if (path === "/web/lista" && request.method === "GET") {
      return await webLista(env);
    }

    if (path.startsWith("/web/obtener/") && request.method === "GET") {
      const id = path.split("/").pop();
      return await webObtener(id, env);
    }

    if (path === "/web/subir_completo" && request.method === "POST") {
      return await webSubirCompleto(request, env);
    }

    if (path.startsWith("/web/editar/") && request.method === "POST") {
      const id = path.split("/").pop();
      return await webEditar(id, request, env);
    }

    if (path.startsWith("/web/borrar/") && request.method === "DELETE") {
      const id = path.split("/").pop();
      return await webBorrar(id, env);
    }

    return new Response("Ruta no encontrada", { status: 404 });
  }
};

// ================================================================
// GODOT — Clasificar imagen con Replicate + Supabase
// ================================================================
async function clasificarImagen(request, env) {
  try {
    const body = await request.json();
    const imagenBase64 = body.imagen;

    if (!imagenBase64) {
      return jsonResponse({ error: "Falta el campo imagen" }, 400);
    }

    const replicateRes = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Token ${env.REPLICATE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "75b33f253f7714a281ad3e9b28f63e3232d583716ef6718f2e46641077ea040a",
        input: { image: `data:image/jpeg;base64,${imagenBase64}` }
      })
    });

    const prediction = await replicateRes.json();

    if (!prediction.id) {
      return jsonResponse({ error: "Replicate no devolvió ID", detalle: prediction }, 500);
    }

    const embedding = await pollReplicate(prediction.id, env.REPLICATE_API_KEY);

    if (!embedding) {
      return jsonResponse({ error: "Replicate timeout o falló" }, 500);
    }

    const supabaseRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/rpc/buscar_obra_similar`,
      {
        method: "POST",
        headers: {
          "apikey": env.SUPABASE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query_embedding: embedding,
          umbral: 0.75,
          limite: 1
        })
      }
    );

    const obras = await supabaseRes.json();

    if (!obras || obras.length === 0) {
      return jsonResponse({ match: false }, 404);
    }

    const obra = obras[0];
    return jsonResponse({
      match: true,
      confianza: Math.round(obra.similitud * 100),
      nombre: obra.nombre,
      cultura: obra.cultura,
      epoca: obra.epoca,
      material: obra.material,
      ubicacion: obra.ubicacion,
      resumen: obra.resumen,
    });

  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ================================================================
// WEB — Lista completa del inventario
// ================================================================
async function webLista(env) {
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/obras?select=id,nombre,museo_id&order=id.desc`,
      {
        headers: {
          "apikey": env.SUPABASE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_KEY}`,
        }
      }
    );
    const data = await res.json();
    return jsonResponse(data);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ================================================================
// WEB — Obtener una pieza por ID
// ================================================================
async function webObtener(id, env) {
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/obras?id=eq.${id}&select=id,nombre,museo_id,cultura,epoca,material,ubicacion,resumen`,
      {
        headers: {
          "apikey": env.SUPABASE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_KEY}`,
        }
      }
    );
    const data = await res.json();
    if (!data || data.length === 0) return jsonResponse({ error: "No encontrada" }, 404);
    return jsonResponse(data[0]);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ================================================================
// WEB — Subir pieza nueva con fotos
// ================================================================
async function webSubirCompleto(request, env) {
  try {
    const formData = await request.formData();
    const metadata = JSON.parse(formData.get("metadata"));
    const fotos = formData.getAll("fotos");

    if (!fotos || fotos.length === 0) {
      return jsonResponse({ error: "Se requiere al menos una foto" }, 400);
    }

    // Generar embeddings para cada foto y promediarlos
    const embeddings = [];
    for (const foto of fotos.slice(0, 5)) {
      const buffer = await foto.arrayBuffer();
      const b64 = arrayBufferToBase64(buffer);

      const repRes = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: {
          "Authorization": `Token ${env.REPLICATE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          version: "75b33f253f7714a281ad3e9b28f63e3232d583716ef6718f2e46641077ea040a",
          input: { image: `data:image/jpeg;base64,${b64}` }
        })
      });

      const pred = await repRes.json();
      if (!pred.id) continue;

      const emb = await pollReplicate(pred.id, env.REPLICATE_API_KEY);
      if (emb) embeddings.push(emb);
    }

    if (embeddings.length === 0) {
      return jsonResponse({ error: "No se pudo generar embedding de ninguna foto" }, 500);
    }

    // Promediar embeddings
    const embeddingFinal = promediarEmbeddings(embeddings);

    // Guardar en Supabase
    const insertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/obras`, {
      method: "POST",
      headers: {
        "apikey": env.SUPABASE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
      },
      body: JSON.stringify({
        nombre:    metadata.nombre,
        museo_id:  metadata.museo,
        cultura:   metadata.cultura,
        epoca:     metadata.epoca,
        material:  metadata.material,
        ubicacion: metadata.ubicacion,
        resumen:   metadata.resumen,
        embedding: embeddingFinal,
      })
    });

    const inserted = await insertRes.json();
    return jsonResponse({
      ok: true,
      id: inserted[0]?.id,
      fotos_procesadas: embeddings.length
    });

  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ================================================================
// WEB — Editar pieza existente
// ================================================================
async function webEditar(id, request, env) {
  try {
    const formData = await request.formData();
    const metadata = JSON.parse(formData.get("metadata"));
    const fotos = formData.getAll("fotos");

    const updateData = {
      nombre:    metadata.nombre,
      museo_id:  metadata.museo,
      cultura:   metadata.cultura,
      epoca:     metadata.epoca,
      material:  metadata.material,
      ubicacion: metadata.ubicacion,
      resumen:   metadata.resumen,
    };

    // Si hay fotos nuevas, regenerar embedding
    let embeddingActualizado = false;
    if (fotos && fotos.length > 0 && fotos[0].size > 0) {
      const embeddings = [];
      for (const foto of fotos.slice(0, 5)) {
        const buffer = await foto.arrayBuffer();
        const b64 = arrayBufferToBase64(buffer);

        const repRes = await fetch("https://api.replicate.com/v1/predictions", {
          method: "POST",
          headers: {
            "Authorization": `Token ${env.REPLICATE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            version: "75b33f253f7714a281ad3e9b28f63e3232d583716ef6718f2e46641077ea040a",
            input: { image: `data:image/jpeg;base64,${b64}` }
          })
        });

        const pred = await repRes.json();
        if (!pred.id) continue;
        const emb = await pollReplicate(pred.id, env.REPLICATE_API_KEY);
        if (emb) embeddings.push(emb);
      }

      if (embeddings.length > 0) {
        updateData.embedding = promediarEmbeddings(embeddings);
        embeddingActualizado = true;
      }
    }

    await fetch(`${env.SUPABASE_URL}/rest/v1/obras?id=eq.${id}`, {
      method: "PATCH",
      headers: {
        "apikey": env.SUPABASE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(updateData)
    });

    return jsonResponse({ ok: true, embedding_actualizado: embeddingActualizado });

  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ================================================================
// WEB — Borrar pieza
// ================================================================
async function webBorrar(id, env) {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/obras?id=eq.${id}`, {
      method: "DELETE",
      headers: {
        "apikey": env.SUPABASE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_KEY}`,
      }
    });
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ================================================================
// HELPERS
// ================================================================
async function pollReplicate(predictionId, apiKey, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000);
    const res = await fetch(
      `https://api.replicate.com/v1/predictions/${predictionId}`,
      { headers: { "Authorization": `Token ${apiKey}` } }
    );
    const data = await res.json();
    if (data.status === "succeeded") return data.output;
    if (data.status === "failed") return null;
  }
  return null;
}

function promediarEmbeddings(embeddings) {
  const largo = embeddings[0].length;
  const resultado = new Array(largo).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < largo; i++) {
      resultado[i] += emb[i];
    }
  }
  return resultado.map(v => v / embeddings.length);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
