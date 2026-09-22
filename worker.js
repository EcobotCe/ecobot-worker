export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Rota que vai receber os dados do TagoIO
    if (request.method === "POST" && url.pathname === "/webhook-tago") {
      try {
        const body = await request.json();

        // Extrai as variáveis que o TagoIO envia
        const payload = {
          dispositivo: body.device || "Elion",
          variavel: body.variable || "desconhecido",
          valor: body.value ?? 0,
          timestamp: new Date().toISOString()
        };

        // Grava no Firestore através da REST API do Firebase
        const firebaseUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/medicoes`;

        const response = await fetch(firebaseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fields: {
              dispositivo: { stringValue: payload.dispositivo },
              variavel: { stringValue: payload.variavel },
              valor: { doubleValue: Number(payload.valor) },
              timestamp: { stringValue: payload.timestamp }
            }
          })
        });

        if (!response.ok) {
          throw new Error(`Erro Firebase: ${response.statusText}`);
        }

        return new Response(JSON.stringify({ status: "sucesso" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });

      } catch (err) {
        return new Response(JSON.stringify({ erro: err.message }), { status: 500 });
      }
    }

    return new Response("Rota não encontrada", { status: 404 });
  }
};
