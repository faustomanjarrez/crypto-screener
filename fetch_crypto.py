# ═══════════════════════════════════════════════════════════════════════════
#  Crypto Value Screener — pipeline de datos
#  Fuentes (todas gratuitas, sin API key):
#    · DefiLlama  — fees, revenue, holders revenue, TVL, protocolos y chains
#    · CoinGecko  — market cap, FDV, precio
#    · alternative.me — Fear & Greed Index
#  Genera app/data.js (var CRYPTO={...}) y crypto_screen.json
#
#  Uso:  python fetch_crypto.py [--cache-dir DIR]
#        --cache-dir: reutiliza descargas previas si existen (para desarrollo)
# ═══════════════════════════════════════════════════════════════════════════
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except AttributeError:
    pass

BASE = os.path.dirname(os.path.abspath(__file__))
LLAMA = 'https://api.llama.fi'
COINGECKO = 'https://api.coingecko.com/api/v3'

FAIR_PF = 25          # P/F "justo" — análogo al P/E 15 de Graham, ajustado a crypto
MIN_FEES_30D = 30_000  # fees mínimos en 30 días para entrar al universo
MIN_MCAP = 5e6         # market cap mínimo
MAX_ROWS = 450         # tope de filas en data.js

CACHE_DIR = None
if '--cache-dir' in sys.argv:
    CACHE_DIR = sys.argv[sys.argv.index('--cache-dir') + 1]


def log(msg):
    print(msg, flush=True)


def http_get(url, retries=4, timeout=90):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'crypto-value-screener/1.0'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:
            last = e
            wait = 25 * (i + 1)
            log(f'  ⚠ reintento {i + 1}/{retries} en {wait}s — {url[:90]} ({e})')
            time.sleep(wait)
    raise last


def get_cached(name, url):
    """Descarga url; con --cache-dir reutiliza/guarda una copia local."""
    if CACHE_DIR:
        path = os.path.join(CACHE_DIR, name)
        if os.path.exists(path):
            log(f'  · {name} (caché)')
            with open(path, encoding='utf-8') as f:
                return json.load(f)
        data = http_get(url)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        return data
    return http_get(url)


# ── 1. Descargas DefiLlama ─────────────────────────────────────────────────
def download_llama():
    over = '/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true'
    log('Descargando DefiLlama…')
    # la llamada principal de fees trae también totalDataChart (serie diaria
    # de fees de TODO el mercado) para la gráfica histórica
    fees = get_cached('llama_fees_chart.json',
                      LLAMA + '/overview/fees?excludeTotalDataChartBreakdown=true')
    rev = get_cached('llama_revenue.json', LLAMA + over + '&dataType=dailyRevenue')
    hold = get_cached('llama_holders.json', LLAMA + over + '&dataType=dailyHoldersRevenue')
    prots = get_cached('llama_protocols.json', LLAMA + '/protocols')
    lite = get_cached('llama_lite.json', LLAMA + '/lite/protocols2')
    chains = get_cached('llama_chains.json', LLAMA + '/chains')
    return fees, rev, hold, prots, lite, chains


# ── 2. Construcción de entidades ───────────────────────────────────────────
# Una "entidad" agrupa todas las versiones de un protocolo (Uniswap V2+V3+V4
# → Uniswap) bajo su parent de DefiLlama, o es una chain (Ethereum, Solana…).
def build_entities(fees, rev, hold, prots, lite, chains):
    child_by_name = {p['name']: p for p in prots}
    parents = {p['id']: p for p in lite.get('parentProtocols', [])}
    chain_by_lname = {c['name'].lower(): c for c in chains}

    def resolve_key(f):
        """protocolo de un overview → clave de entidad estable."""
        if f.get('protocolType') == 'chain':
            return 'chain:' + f['slug']
        child = child_by_name.get(f['name'])
        if child and child.get('parentProtocol'):
            return child['parentProtocol']
        if child:
            return 'p:' + child['slug']
        return 'p:' + f['slug']

    entities = {}

    def ent(key):
        if key not in entities:
            entities[key] = {
                'key': key, 'f24': 0, 'f30': 0, 'f60to30': 0, 'f1y': 0,
                'r30': 0, 'r1y': 0, 'h30': 0, 'h1y': 0,
                'tvl': 0, 'listedAt': None, 'cats': {}, 'name': None,
                'gecko': None, 'url': None, 'audits': 0,
            }
        return entities[key]

    # fees (dataset principal: define el universo)
    for f in fees['protocols']:
        cat = (f.get('category') or '').strip()
        if 'stablecoin issue' in cat.lower():
            continue  # Tether/Circle: sus fees no acumulan al token USDT/USDC
        e = ent(resolve_key(f))
        e['f24'] += f.get('total24h') or 0
        e['f30'] += f.get('total30d') or 0
        e['f60to30'] += f.get('total60dto30d') or 0
        e['f1y'] += f.get('total1y') or 0
        e['cats'][cat] = e['cats'].get(cat, 0) + (f.get('total30d') or 0)
        if f.get('protocolType') == 'chain':
            e['name'] = e['name'] or f['name']
            ch = chain_by_lname.get(f['name'].lower())
            if ch:
                e['gecko'] = ch.get('gecko_id')
                e['tvl'] = ch.get('tvl') or 0

    # revenue y holders revenue sobre las mismas claves
    for dataset, k30, k1y in ((rev, 'r30', 'r1y'), (hold, 'h30', 'h1y')):
        for f in dataset['protocols']:
            key = resolve_key(f)
            if key in entities:
                entities[key][k30] += f.get('total30d') or 0
                entities[key][k1y] += f.get('total1y') or 0

    # TVL, antigüedad, gecko_id y metadatos desde /protocols (todos los hijos)
    for p in prots:
        key = p.get('parentProtocol') or ('p:' + p['slug'])
        if key not in entities:
            continue
        e = entities[key]
        e['tvl'] += p.get('tvl') or 0
        if p.get('listedAt'):
            e['listedAt'] = min(e['listedAt'] or 1e18, p['listedAt'])
        if not e['gecko'] and p.get('gecko_id'):
            e['gecko'] = p['gecko_id']
        e['url'] = e['url'] or p.get('url')
        try:
            e['audits'] = max(e['audits'], int(p.get('audits') or 0))
        except (TypeError, ValueError):
            pass

    # metadatos del parent (nombre limpio + gecko_id oficial)
    for key, e in entities.items():
        if key.startswith('parent#') and key in parents:
            par = parents[key]
            e['name'] = par['name']
            e['gecko'] = par.get('gecko_id') or e['gecko']
            e['url'] = par.get('url') or e['url']
        elif not e['name']:
            slug = key.split(':', 1)[-1]
            child = next((p for p in prots if p['slug'] == slug), None)
            e['name'] = child['name'] if child else slug.replace('-', ' ').title()

    # categoría dominante (la que más fees aporta)
    for e in entities.values():
        e['category'] = max(e['cats'], key=e['cats'].get) if e['cats'] else 'Otros'
        del e['cats']

    return entities


# ── 3. CoinGecko: mcap / FDV / precio ──────────────────────────────────────
def fetch_coingecko(gecko_ids):
    log(f'Descargando CoinGecko para {len(gecko_ids)} tokens…')
    out = {}
    ids = sorted(gecko_ids)
    batches = [ids[i:i + 200] for i in range(0, len(ids), 200)]
    cached = get_cached('cg_markets.json', 'about:blank') if CACHE_DIR and \
        os.path.exists(os.path.join(CACHE_DIR, 'cg_markets.json')) else None
    if cached:
        return {c['id']: c for c in cached}
    rows = []
    for i, batch in enumerate(batches):
        url = (f'{COINGECKO}/coins/markets?vs_currency=usd'
               f'&ids={urllib.parse.quote(",".join(batch))}&per_page=250')
        rows += http_get(url)
        log(f'  · lote {i + 1}/{len(batches)} ok')
        if i < len(batches) - 1:
            time.sleep(15)  # free tier: ~10-30 req/min
    if CACHE_DIR:
        with open(os.path.join(CACHE_DIR, 'cg_markets.json'), 'w', encoding='utf-8') as f:
            json.dump(rows, f)
    return {c['id']: c for c in rows}


# ── 4. Métricas del screener ───────────────────────────────────────────────
def rnd(v, d=2):
    return None if v is None else round(v, d)


def build_rows(entities, cg):
    now = datetime.now(timezone.utc)
    rows = []
    for e in entities.values():
        c = cg.get(e['gecko'])
        if not c or not c.get('market_cap'):
            continue
        mcap = c['market_cap']
        if mcap < MIN_MCAP:
            continue

        fees_ann = e['f30'] * 365 / 30
        pf = mcap / fees_ann if fees_ann > 0 else None
        rev_ann = e['r30'] * 365 / 30
        hold_ann = e['h30'] * 365 / 30
        pr = mcap / rev_ann if rev_ann > 0 else None
        g30 = ((e['f30'] - e['f60to30']) / e['f60to30'] * 100) if e['f60to30'] > 0 else None
        fdv = c.get('fully_diluted_valuation')
        fdv_mc = fdv / mcap if fdv else None
        mc_tvl = mcap / e['tvl'] if e['tvl'] > 1e6 else None
        yld = hold_ann / mcap * 100 if hold_ann > 0 else 0

        # antigüedad: alta en DefiLlama, o (respaldo) fecha más vieja conocida
        # de ATH/ATL en CoinGecko — cota inferior de la edad real
        ts = e['listedAt']
        for k in ('ath_date', 'atl_date'):
            if c.get(k):
                try:
                    t = datetime.fromisoformat(c[k].replace('Z', '+00:00')).timestamp()
                    ts = min(ts or 1e18, t)
                except ValueError:
                    pass
        age = (now.timestamp() - ts) / 31_557_600 if ts else None

        mos = (1 - pf / FAIR_PF) * 100 if pf is not None else None
        # MoS diluido: mismo cálculo pero sobre FDV — castiga la dilución
        # pendiente (lección SECZ: P/F 0.1 con 96% de tokens sin emitir)
        pf_fdv = fdv / fees_ann if (fdv and fees_ann > 0) else None
        mos_fdv = (1 - pf_fdv / FAIR_PF) * 100 if pf_fdv is not None else None
        stars = 0
        if pf is not None and pf <= FAIR_PF:
            stars += 1
        if fdv_mc is not None and fdv_mc <= 1.5:
            stars += 1
        if g30 is not None and g30 > 0:
            stars += 1
        if age is not None and age >= 2:
            stars += 1
        trap = bool(pf is not None and pf < 8 and g30 is not None and g30 < -30)

        price = c.get('current_price')
        rows.append({
            'ticker': (c.get('symbol') or '?').upper(),
            'name': e['name'],
            'category': e['category'],
            'gecko': e['gecko'],
            'url': e['url'],
            'price': rnd(price, 2 if (price or 0) >= 1 else 6),
            'market_cap': round(mcap),
            'fdv': round(fdv) if fdv else None,
            'tvl': round(e['tvl']) if e['tvl'] > 0 else None,
            'fees30d': round(e['f30']),
            'fees_ann': round(fees_ann),
            'rev_ann': round(rev_ann) if rev_ann > 0 else None,
            'hold_ann': round(hold_ann) if hold_ann > 0 else None,
            'pf': rnd(pf, 1),
            'pr': rnd(pr, 1),
            'fdv_mc': rnd(fdv_mc, 2),
            'mc_tvl': rnd(mc_tvl, 2),
            'g30': rnd(g30, 1),
            'age': rnd(age, 1),
            'yield': rnd(yld, 2),
            'ath_down': rnd(c.get('ath_change_percentage'), 1),
            'audits': e['audits'] or None,
            'mos': rnd(mos, 1),
            'pf_fdv': rnd(pf_fdv, 1),
            'mos_fdv': rnd(mos_fdv, 1),
            'stars': stars,
            'trap': trap,
            'valid': pf is not None,
        })
    rows.sort(key=lambda r: r['fees30d'], reverse=True)
    return rows[:MAX_ROWS]


# ── 5. Series históricas ───────────────────────────────────────────────────
def build_market_fees_series(fees):
    """Fees anualizados de todo el mercado (suma móvil 30d × 12.17),
    último año, muestreado cada 7 días."""
    chart = fees.get('totalDataChart') or []
    if len(chart) < 40:
        return []
    daily = [(int(ts), v or 0) for ts, v in chart]
    out = []
    for i in range(29, len(daily)):
        ann = sum(v for _, v in daily[i - 29:i + 1]) * 365 / 30
        day = datetime.fromtimestamp(daily[i][0], timezone.utc).strftime('%Y-%m-%d')
        out.append([day, round(ann)])
    out = out[-365:]
    # muestreo semanal conservando siempre el último punto
    sampled = out[::-7][::-1]
    return sampled


def update_history(med_pf, fng, glob, valid, under):
    """Upsert de la entrada de hoy en history.json (se acumula día a día)."""
    path = os.path.join(BASE, 'history.json')
    hist = []
    if os.path.exists(path):
        try:
            with open(path, encoding='utf-8') as f:
                hist = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            log(f'  ⚠ history.json ilegible, se reinicia: {e}')
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    entry = {
        'd': today,
        'pf': round(med_pf, 1) if med_pf is not None else None,
        'fng': fng.get('value'),
        'mcap': glob.get('mcap'),
        'up': round(under / valid * 100, 1) if valid else None,
    }
    hist = [h for h in hist if h.get('d') != today] + [entry]
    hist.sort(key=lambda h: h['d'])
    hist = hist[-1095:]  # ~3 años
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(hist, f, ensure_ascii=False, indent=0)
    return hist


# ── 6. Contexto de mercado ─────────────────────────────────────────────────
def fetch_market_context():
    fng = {}
    glob = {}
    try:
        d = get_cached('fng.json', 'https://api.alternative.me/fng/?limit=1')['data'][0]
        fng = {'value': int(d['value']), 'label': d['value_classification'],
               'date': datetime.fromtimestamp(int(d['timestamp']), timezone.utc).isoformat()}
    except Exception as e:
        log(f'  ⚠ Fear & Greed no disponible: {e}')
    try:
        g = get_cached('global.json', COINGECKO + '/global')['data']
        glob = {'mcap': round(g['total_market_cap']['usd']),
                'btc_dom': round(g['market_cap_percentage']['btc'], 1),
                'eth_dom': round(g['market_cap_percentage']['eth'], 1)}
    except Exception as e:
        log(f'  ⚠ CoinGecko /global no disponible: {e}')
    return fng, glob


# ── main ───────────────────────────────────────────────────────────────────
def main():
    t0 = time.time()
    fees, rev, hold, prots, lite, chains = download_llama()
    log(f'  {len(fees["protocols"])} protocolos con fees')

    entities = build_entities(fees, rev, hold, prots, lite, chains)
    candidates = {k: e for k, e in entities.items()
                  if e['gecko'] and e['f30'] >= MIN_FEES_30D}
    log(f'  {len(entities)} entidades → {len(candidates)} con token y fees ≥ ${MIN_FEES_30D:,}/30d')

    cg = fetch_coingecko({e['gecko'] for e in candidates.values()})
    rows = build_rows(candidates, cg)
    fng, glob = fetch_market_context()

    valid = [r for r in rows if r['valid']]
    under = [r for r in valid if r['mos'] is not None and r['mos'] >= 0]
    strong = [r for r in under if r['mos'] >= 33 and not r['trap']]

    pfs = sorted(r['pf'] for r in valid if r['pf'] is not None)
    med_pf = pfs[len(pfs) // 2] if pfs else None
    market_fees = build_market_fees_series(fees)
    history = update_history(med_pf, fng, glob, len(valid), len(under))

    data = {
        'updated': datetime.now(timezone.utc).isoformat(),
        'source': 'DefiLlama (fees/TVL) + CoinGecko (mcap/FDV)',
        'fair_pf': FAIR_PF,
        'total': len(rows), 'valid': len(valid),
        'undervalued': len(under), 'strong': len(strong),
        'fng': fng, 'global': glob,
        'med_pf': med_pf,
        'history': history,
        'market_fees': market_fees,
        'protocols': rows,
    }

    stamp = datetime.now().strftime('%Y-%m-%d %H:%M')
    body = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    js = (f'// Crypto Value Screener — auto-generado {stamp}\n'
          f'var CRYPTO={body};\n')
    with open(os.path.join(BASE, 'app', 'data.js'), 'w', encoding='utf-8') as f:
        f.write(js)
    with open(os.path.join(BASE, 'crypto_screen.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)

    log(f'✓ {len(rows)} protocolos ({len(under)} subvaluados, {len(strong)} MoS≥33%) '
        f'en {time.time() - t0:.0f}s → app/data.js')


if __name__ == '__main__':
    main()
