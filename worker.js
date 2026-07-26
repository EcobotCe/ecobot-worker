/**
 * ECOBOT - Worker de API (Cloudflare Workers)
 * ---------------------------------------------
 * Substitui o antigo server.js (Express/Railway).
 *
 * O que ele faz:
 *  - Gerencia a lista de bases (estações) via Workers KV (grátis, sem banco externo)
 *  - Faz proxy para a API do TagoIO (evita erro de CORS no navegador)
 *  - NÃO envia e-mail, NÃO usa PostgreSQL, NÃO precisa de cron externo
 *
 * Rotas:
 *   GET    /health
 *   GET    /api/bases
 *   POST   /api/bases              (cria ou atualiza uma base)
 *   DELETE /api/bases/:id          (exige adminPassword no body)
 *   GET    /api/bases/lixeira      (exige ?adminPassword=...)
 *   GET    /api/dados-recentes     (agrega dados de todas as bases)
 *   GET    /api/test-tago?baseId=&qty=&start_date=&end_date=
 *   GET    /api/alerts             (stub - sempre retorna [], não há mais histórico por e-mail)
 *
 * KV usado (binding "BASES_KV"):
 *   chave "bases" -> JSON.stringify(array de bases), mesmo formato do antigo data/bases.json
 *
 * Secret necessário (ver MIGRACAO.md):
 *   ADMIN_PASSWORD -> senha para deletar bases / ver lixeira
 */

const KV_KEY_BASES = 'bases';

// ── Helpers de resposta ──────────────────────────────────────────────
function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            ...extraHeaders
        }
    });
}

function notFound(msg = 'Não encontrado') {
    return json({ error: msg }, 404);
}

// ── Helpers de dados ──────────────────────────────────────────────────
async function getAllBases(env) {
    const raw = await env.BASES_KV.get(KV_KEY_BASES);
    if (!raw) return [];
    try {
        return JSON.parse(raw);
    } catch {
        return [];
    }
}

async function saveBases(env, bases) {
    await env.BASES_KV.put(KV_KEY_BASES, JSON.stringify(bases));
}

function getActiveBases(bases) {
    return bases.filter((base) => !base.deleted_at);
}

function getNextId(items) {
    const ids = items.map((item) => Number(item.id)).filter((id) => !Number.isNaN(id));
    return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}

// ── Cache simples em memória (dura enquanto o isolate do Worker viver) ──
// Em Cloudflare Workers, cada instância já é "descartável" e há edge caching
// nativo; isso apenas evita bater no TagoIO em rajadas muito próximas.
let dadosRecentesCache = { ts: 0, data: null };
const CACHE_TTL_MS = 60 * 1000;

// ── Rotas ────────────────────────────────────────────────────────────
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const { pathname } = url;
        const method = request.method;

        // Pré-flight CORS
        if (method === 'OPTIONS') {
            return json({ ok: true });
        }

        try {
            if (pathname === '/health') {
                return json({
                    status: 'ok',
                    timestamp: new Date().toISOString(),
                    storage: 'workers-kv',
                    server: 'Cloudflare Workers'
                });
            }

            if (pathname === '/api/alerts' && method === 'GET') {
                // Stub: não há mais envio de e-mail/checagem automática,
                // então não existe histórico persistido por enquanto.
                return json([]);
            }

            if (pathname === '/api/bases' && method === 'GET') {
                const bases = getActiveBases(await getAllBases(env));
                const safe = bases.map((b) => ({
                    id: b.id,
                    nome: b.nome,
                    lat: b.lat ?? null,
                    lon: b.lon ?? null
                }));
                return json(safe);
            }

            if (pathname === '/api/bases' && method === 'POST') {
                const body = await request.json().catch(() => ({}));
                const { id, nome, token, lat, lon } = body;
                if (!nome) return json({ error: 'O nome é obrigatório.' }, 400);

                const latValue = lat !== undefined && lat !== null && lat !== '' ? parseFloat(lat) : null;
                const lonValue = lon !== undefined && lon !== null && lon !== '' ? parseFloat(lon) : null;

                const bases = await getAllBases(env);

                if (id) {
                    const idx = bases.findIndex((b) => Number(b.id) === Number(id));
                    if (idx === -1) return notFound('Base não encontrada.');
                    bases[idx] = {
                        ...bases[idx],
                        nome,
                        token: token || bases[idx].token,
                        lat: latValue,
                        lon: lonValue
                    };
                    await saveBases(env, bases);
                    return json({ id: bases[idx].id, nome, lat: latValue, lon: lonValue });
                }

                if (!token) return json({ error: 'O token é obrigatório para criação de uma nova base.' }, 400);
                if (bases.some((b) => b.nome === nome && !b.deleted_at)) {
                    return json({ error: 'Já existe uma base com esse nome.' }, 409);
                }

                const newBase = { id: getNextId(bases), nome, token, lat: latValue, lon: lonValue, deleted_at: null };
                bases.push(newBase);
                await saveBases(env, bases);
                return json({ id: newBase.id, nome: newBase.nome, lat: newBase.lat, lon: newBase.lon }, 201);
            }

            const deleteMatch = pathname.match(/^\/api\/bases\/(\d+)$/);
            if (deleteMatch && method === 'DELETE') {
                const id = parseInt(deleteMatch[1], 10);
                const body = await request.json().catch(() => ({}));

                if (!env.ADMIN_PASSWORD) return json({ error: 'Senha de administrador não configurada no Worker.' }, 500);
                if (!body.adminPassword || body.adminPassword !== env.ADMIN_PASSWORD) {
                    return json({ error: 'Senha de administrador incorreta.' }, 403);
                }

                const bases = await getAllBases(env);
                const idx = bases.findIndex((b) => Number(b.id) === id && !b.deleted_at);
                if (idx === -1) return notFound('Base não encontrada.');

                bases[idx].deleted_at = new Date().toISOString();
                await saveBases(env, bases);
                return json({ message: 'Base removida com sucesso.' });
            }

            if (pathname === '/api/bases/lixeira' && method === 'GET') {
                const adminPassword = url.searchParams.get('adminPassword');
                if (!env.ADMIN_PASSWORD || adminPassword !== env.ADMIN_PASSWORD) {
                    return json({ error: 'Acesso negado.' }, 403);
                }
                const bases = await getAllBases(env);
                const deleted = bases
                    .filter((b) => b.deleted_at)
                    .map((b) => ({ id: b.id, nome: b.nome, lat: b.lat, lon: b.lon, deleted_at: b.deleted_at }))
                    .sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at));
                return json(deleted);
            }

            if (pathname === '/api/dados-recentes' && method === 'GET') {
                if (dadosRecentesCache.data && Date.now() - dadosRecentesCache.ts < CACHE_TTL_MS) {
                    return json(dadosRecentesCache.data);
                }

                const bases = getActiveBases(await getAllBases(env));
                if (bases.length === 0) return json([]);

                const resultados = await Promise.all(
                    bases.map(async (base) => {
                        if (!base.token) return { nome: base.nome, temp: null, umid: null, gas: null, timestamp: null, dados: [] };
                        try {
                            const resp = await fetch('https://api.tago.io/data?qty=60', {
                                headers: { 'Device-Token': base.token }
                            });
                            const payload = await resp.json();
                            const dados = Array.isArray(payload?.result) ? payload.result : [];
                            const getVal = (pref) => {
                                const item = dados.find((d) => d.variable && d.variable.toLowerCase().includes(pref));
                                return item ? parseFloat(String(item.value).replace(',', '.')) : null;
                            };
                            return {
                                nome: base.nome,
                                temp: getVal('temp'),
                                umid: getVal('umid'),
                                gas: getVal('co2') ?? getVal('gas'),
                                timestamp: dados[0]?.time ?? null,
                                dados: dados.slice(0, 5)
                            };
                        } catch (err) {
                            return { nome: base.nome, temp: null, umid: null, gas: null, timestamp: null, dados: [] };
                        }
                    })
                );

                dadosRecentesCache = { ts: Date.now(), data: resultados };
                return json(resultados);
            }

            if (pathname === '/api/test-tago' && method === 'GET') {
                const baseId = url.searchParams.get('baseId');
                const qty = url.searchParams.get('qty') || '60';
                const startDate = url.searchParams.get('start_date');
                const endDate = url.searchParams.get('end_date');
                if (!baseId) return json({ error: 'baseId é obrigatório.' }, 400);

                const bases = getActiveBases(await getAllBases(env));
                const base = bases.find((b) => Number(b.id) === Number(baseId));
                if (!base || !base.token) return notFound('Base não encontrada.');

                const params = new URLSearchParams({ qty });
                if (startDate) params.set('start_date', startDate);
                if (endDate) params.set('end_date', endDate);

                const resp = await fetch(`https://api.tago.io/data?${params.toString()}`, {
                    headers: { 'Device-Token': base.token }
                });
                const data = await resp.json().catch(() => ({}));
                return json(data, resp.status);
            }

            return notFound();
        } catch (err) {
            return json({ error: 'Erro interno no Worker.', detalhe: err.message }, 500);
        }
    }
};
