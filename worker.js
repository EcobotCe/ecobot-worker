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

// ── LISTA FIXA DE BASES (não depende mais do KV) ───────────────────────
// Edite aqui pra adicionar/remover/atualizar uma estação. Depois de editar,
// só fazer commit + push que o Cloudflare já redeploya sozinho (Workers
// Builds). Isso resolve o problema de "perder o banco de dados": a lista
// agora mora no próprio código, versionada no Git.
const BASES_FIXAS = [
    {
        id: 1,
        nome: 'Elion - EEEPDJWM',
        token: 'b8880259-b7b8-4317-add7-f8499b2b331c',
        lat: -6.404229,
        lon: -38.877467
    }
    // { id: 2, nome: 'Elion - EEEPDJWM 2.0', token: 'COLE_O_TOKEN_AQUI', lat: null, lon: null },
];

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
// Antes buscava do KV; agora vem direto da constante BASES_FIXAS acima.
// A assinatura "async" e o parâmetro "env" ficaram só pra não precisar
// mexer no resto do código que já chama essa função.
async function getAllBases(env) {
    return BASES_FIXAS;
}

function getActiveBases(bases) {
    return bases.filter((base) => !base.deleted_at);
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

            // POST/DELETE de bases foram desativados junto com o KV — a lista
            // agora é fixa no código (BASES_FIXAS, lá em cima). Pra adicionar,
            // remover ou editar uma estação, edite essa constante e faça
            // commit + push. Esses endpoints ficam só avisando isso, caso o
            // site antigo ainda tente chamá-los.
            if (pathname === '/api/bases' && method === 'POST') {
                return json({ error: 'Cadastro dinâmico desativado. Edite BASES_FIXAS em worker.js e faça deploy.' }, 410);
            }

            const deleteMatch = pathname.match(/^\/api\/bases\/(\d+)$/);
            if (deleteMatch && method === 'DELETE') {
                return json({ error: 'Remoção dinâmica desativada. Edite BASES_FIXAS em worker.js e faça deploy.' }, 410);
            }

            if (pathname === '/api/bases/lixeira' && method === 'GET') {
                return json([]);
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
