// Cloudflare Worker: museo-clasificador
// Formato compatible con upload directo (sin Wrangler)

addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      }
    });
  }

  if (request.method !== "POST") {
    return new Response("Solo POST", { status: 405 });
  }

  try {
    const body = await request.json();
    const imagenBase64 = body.imagen;

    if (!imagenBase64) {
      return jsonResponse({ error: "Falta el campo 'imagen'" }, 400);
    }

    // Enviar a Replicate
    const replicateRes = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Token ${REPLICATE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "75b33f253f7714a281ad3e9b28f63e3232d583716ef6718f2e46641077ea040a",
        input: {
          image: `data:image/jpeg;base64,${imagenBase64}`
        }
      })
    });

    const prediction = await replicateRes.json();
    const embedding = await pollReplicate(prediction.id);

    if (!embedding) {
      return jsonResponse({ error: "Replicate no respondió a tiempo" }, 500);
    }

    // Buscar en Supabase
    const supabaseRes = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/buscar_obra_similar`,
      {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
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

async function pollReplicate(predictionId, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000);
    const res = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { "Authorization": `Token ${REPLICATE_API_KEY}` }
    });
    const data = await res.json();
    if (data.status === "succeeded") return data.output;
    if (data.status === "failed") return null;
  }
  return null;
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