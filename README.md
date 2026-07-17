# Crypto Value Screener

Screener de protocolos crypto **subvaluados por fundamentales on-chain** — la filosofía de
Benjamin Graham traducida a crypto: en lugar de EPS y valor libro, usa **fees reales**,
**TVL** y **tokenomics**.

**App (PWA):** https://faustomanjarrez.github.io/crypto-screener/

## Método

| Concepto Graham | Equivalente crypto | Métrica |
|---|---|---|
| P/E | P/F | Market cap ÷ fees anualizados |
| P/B | MC/TVL | Market cap ÷ capital depositado |
| Deuda/Capital | FDV/MC | Dilución pendiente por unlocks |
| Dividendo | Real yield | Fees repartidos a holders/stakers |
| Historial de utilidades | Edad ≥ 2 años | Sobrevivió un ciclo bajista |
| Margen de seguridad | MoS = 1 − P/F ÷ 25 | Descuento frente a un P/F "justo" de 25 |

**Score de 4 estrellas:** P/F ≤ 25 · FDV/MC ≤ 1.5 · fees creciendo (30d) · edad ≥ 2 años.

**Trampas de valor:** P/F < 8 con fees cayendo > 30% se marca con ⚠ — barato + deterioro
suele ser un protocolo muriendo, no una ganga.

**MoS diluido (v1.2):** el mismo margen de seguridad calculado sobre FDV en lugar de
market cap — asume toda la emisión futura ya circulando. Es el ranking del Top 10 y evita
que un P/F bajísimo con dilución masiva pendiente (FDV/MC > 3, marcado ⚠) parezca ganga.

**Históricos (v1.3):** cada corrida diaria agrega un punto a `history.json` (P/F mediano,
Fear & Greed, cap total, % subvaluados) — el "Indicador Buffett de crypto" que se
construye solo. Además, la vista Mercado grafica un año de fees anualizados de todo el
mercado (el "PIB on-chain"), con histórico real de DefiLlama.

## Fuentes de datos (gratuitas, sin API key)

- [DefiLlama](https://defillama.com) — fees, revenue, holders revenue, TVL, chains
- [CoinGecko](https://www.coingecko.com) — market cap, FDV, precios
- [alternative.me](https://alternative.me/crypto/fear-and-greed-index/) — Fear & Greed Index

## Arquitectura

- `fetch_crypto.py` — pipeline de datos (solo librería estándar de Python). Agrupa las
  versiones de cada protocolo (Uniswap V2+V3+V4 → Uniswap), cruza fees con market cap
  y calcula los ratios. Genera `app/data.js` y `crypto_screen.json`.
- `app/` — PWA vanilla (sin frameworks), offline-first, ES/EN, tema claro/oscuro.
  Se publica en GitHub Pages.
- `.github/workflows/update-data.yml` — GitHub Actions corre el pipeline **cada día**
  y publica los datos nuevos automáticamente.

## Correr localmente

```
python fetch_crypto.py            # genera app/data.js (~1 min)
```

o doble clic en `run_screener.bat` (Windows). Luego abre `app/index.html` con cualquier
servidor estático.

## Descargo

Herramienta educativa de análisis cuantitativo. Crypto es un mercado extremadamente
volátil donde los fundamentales pesan menos que en acciones. **No es asesoría de inversión.**
