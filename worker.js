/**
 * EcoBot Cloudflare Worker
 * Responsável por integrar TagoIO, Cloudflare Workers e Firebase Firestore.
 */

// Headers CORS para permitir que o site consuma a API sem bloqueios
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Webhook-Secret',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Trata requisições preflight (CORS)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // 1. Rota de Healthcheck
      if (path === '/health') {
        return jsonResponse({
          status: 'ok',
          timestamp: new Date().toISOString(),
          storage: 'firestore',
          server: 'Cloudflare Workers'
        });
      }

      // 2. Rota para receber Webhook do TagoIO e salvar no Firestore
      if (path === '/webhook-tago' && request.method === 'POST') {
        return await handleWebhookTago(request, env);
      }

      // 3. Rota para o site/app obter os dados mais recentes das bases
      if (path === '/api/dados-recentes') {
        return await handleDadosRecentes(env);
      }

      // 4. Rota para listar as bases cadastradas no Firestore
      if (path === '/api/bases') {
        return await handleBases(env);
      }

      // Rota não encontrada
      return jsonResponse({ error: 'Não encontrado' }, 404);

    } catch (error) {
      console.error('Erro na execução do Worker:', error);
      return jsonResponse({ error: 'Erro interno no servidor', details: error.message }, 500);
    }
  }
};

/**
 * Processa o Webhook recebido do TagoIO e grava no Firestore ('medicoes')
 */
async function handleWebhookTago(request, env) {
  const secretHeader = request.headers.get('X-Webhook-Secret');
  
  // Validação de segurança
  if (env.TAGO_WEBHOOK_SECRET && secretHeader !== env.TAGO_WEBHOOK_SECRET) {
    return jsonResponse({ error: 'Não autorizado: Header X-Webhook-Secret inválido ou ausente.' }, 401);
  }

  const payload = await request.json();
  const medicoes = Array.isArray(payload) ? payload : [payload];

  if (!medicoes || medicoes.length === 0) {
    return jsonResponse({ error: 'Payload vazio ou formato inválido' }, 400);
  }

  const token = await getFirestoreAccessToken(env);
  let gravadas = 0;

  for (const item of medicoes) {
    const docData = {
      fields: {
        deviceId: { stringValue: item.device || item.group || 'desconhecido' },
        variable: { stringValue: item.variable || 'desconhecido' },
        value: { doubleValue: Number(item.value ?? 0) },
        unit: { stringValue: item.unit || '' },
        timestamp: { stringValue: item.time || new Date().toISOString() },
        createdAt: { stringValue: new Date().toISOString() }
      }
    };

    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/medicoes`;
    const res = await fetch(firestoreUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(docData)
    });

    if (res.ok) gravadas++;
  }

  return jsonResponse({ status: 'sucesso', gravadas });
}

/**
 * Consulta as bases no Firestore e busca as últimas medições no TagoIO
 */
async function handleDadosRecentes(env) {
  const bases = await fetchBasesFromFirestore(env);
  const resultado = [];

  for (const base of bases) {
    if (!base.token) continue;

    // Busca os dados diretamente da API da TagoIO
    const tagoRes = await fetch('https://api.tago.io/data?qty=15', {
      headers: { 'Device-Token': base.token }
    });

    if (!tagoRes.ok) continue;

    const tagoData = await tagoRes.json();
    const dados = tagoData.result || [];

    // Função auxiliar com busca defensiva de variáveis
    const getVal = (vName) => {
      const item = dados.find(d => d && d.variable === vName);
      return item ? item.value : null;
    };

    const temp = getVal('temperatura') ?? getVal('temp') ?? 0;
    const umid = getVal('umidade') ?? getVal('umid') ?? 0;
    
    // CORREÇÃO: Inclui captura automática para 'qualidade_ar', 'co2' ou 'gas'
    const gas = getVal('co2') ?? getVal('gas') ?? getVal('qualidade_ar') ?? 0;

    const lastItem = dados[0] || {};
    const timestamp = lastItem.time || new Date().toISOString();

    resultado.push({
      nome: base.nome || 'Base Sem Nome',
      temp,
      umid,
      gas,
      timestamp,
      dados
    });
  }

  return jsonResponse(resultado);
}

/**
 * Retorna as bases cadastradas no Firestore em formato simplificado
 */
async function handleBases(env) {
  const bases = await fetchBasesFromFirestore(env);
  
  const basesFormatadas = bases.map(b => ({
    id: hashString(b.nome || 'base'),
    nome: b.nome,
    lat: Number(b.lat || 0),
    lon: Number(b.lon || 0)
  }));

  return jsonResponse(basesFormatadas);
}

/**
 * Busca a coleção 'bases_monitorizacao' no Firestore
 */
async function fetchBasesFromFirestore(env) {
  const token = await getFirestoreAccessToken(env);
  const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/bases_monitorizacao`;

  const response = await fetch(firestoreUrl, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!response.ok) return [];

  const data = await response.json();
  if (!data.documents) return [];

  return data.documents.map(doc => {
    const fields = doc.fields || {};
    return {
      id: doc.name.split('/').pop(),
      nome: fields.nome?.stringValue || '',
      token: fields.token?.stringValue || '',
      lat: fields.lat?.doubleValue || fields.lat?.integerValue || fields.lat?.stringValue || 0,
      lon: fields.lon?.doubleValue || fields.lon?.integerValue || fields.lon?.stringValue || 0
    };
  });
}

/**
 * Autenticação JWT com Firebase Service Account
 */
async function getFirestoreAccessToken(env) {
  const privateKeyPem = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const clientEmail = env.FIREBASE_CLIENT_EMAIL;

  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaim = base64UrlEncode(JSON.stringify(claimSet));
  const signatureInput = `${encodedHeader}.${encodedClaim}`;

  const binaryKey = pemToBinary(privateKeyPem);
  const cryptoKey = await crypto.subcryptoImport(binaryKey);
  
  const signatureArrayBuffer = await crypto.subcryptoSign(
    { name: 'RSASSA-PKCS1-v1_5' },
    cryptoKey,
    new TextEncoder().encode(signatureInput)
  );

  const encodedSignature = base64UrlEncode(signatureArrayBuffer);
  const jwt = `${signatureInput}.${encodedSignature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

// Helpers Utilitários
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json;charset=UTF-8' }
  });
}

function base64UrlEncode(input) {
  let str = typeof input === 'string' 
    ? btoa(unescape(encodeURIComponent(input))) 
    : btoa(String.fromCharCode(...new Uint8Array(input)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToBinary(pem) {
  const lines = pem.split('\n').filter(l => !l.startsWith('-----'));
  const base64 = lines.join('');
  const binaryDerString = atob(base64);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) {
    binaryDer[i] = binaryDerString.charCodeAt(i);
  }
  return binaryDer.buffer;
}

const crypto = {
  subcryptoImport: (keyBuffer) => windowCrypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  ),
  subcryptoSign: (algo, key, data) => windowCrypto.subtle.sign(algo, key, data)
};
const windowCrypto = crypto.webcrypto || globalThis.crypto;

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
