// Holt jede Nacht die Zahlen von Shopify und Meta und speichert sie verschluesselt in docs/daten.enc.json.
// Laeuft in GitHub Actions (Node 20+), braucht keine Pakete.
//
// Umgebungsvariablen (als GitHub Secrets hinterlegt):
//   DASHBOARD_PASSWORT      Passwort, mit dem das Dashboard die Daten entschluesselt
//   SHOPIFY_SHOP            z. B. anastasijas-shop.myshopify.com
//   SHOPIFY_CLIENT_ID       aus dem Dev Dashboard, App "Tages-Dashboard"
//   SHOPIFY_CLIENT_SECRET   aus dem Dev Dashboard, App "Tages-Dashboard"
//   META_AD_ACCOUNT_ID      z. B. act_1234567890 (optional, solange Meta noch fehlt)
//   META_ACCESS_TOKEN       Systemnutzer-Token mit ads_read (optional)
//   TAGE                    wie viele zurueckliegende Tage neu geholt werden (Standard 3, beim ersten Lauf 30)

import { readFile, writeFile } from 'node:fs/promises';
import { webcrypto as crypto } from 'node:crypto';

const DATEI = new URL('../docs/daten.enc.json', import.meta.url);
const SHOPIFY_API = '2026-10';
const META_API = 'v23.0';

const env = (name, pflicht = true) => {
  const wert = (process.env[name] || '').trim();
  if (pflicht && !wert) throw new Error(`Secret ${name} fehlt`);
  return wert;
};

// ---------- Verschluesselung (AES-GCM, Schluessel per PBKDF2 aus dem Passwort) ----------

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const ITERATIONEN = 250000;

async function schluessel(passwort, salt) {
  const basis = await crypto.subtle.importKey('raw', new TextEncoder().encode(passwort), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONEN, hash: 'SHA-256' },
    basis, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function verschluesseln(obj, passwort) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await schluessel(passwort, salt);
  const daten = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { v: 1, iter: ITERATIONEN, salt: b64(salt), iv: b64(iv), daten: b64(daten) };
}

async function entschluesseln(paket, passwort) {
  const key = await schluessel(passwort, unb64(paket.salt));
  const klar = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(paket.iv) }, key, unb64(paket.daten));
  return JSON.parse(new TextDecoder().decode(klar));
}

// ---------- Datum und Zeitzone ----------

function heuteIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function plusTage(tag, n) {
  const d = new Date(`${tag}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Versatz der Zeitzone an einem Tag, z. B. "+02:00"
function versatz(tag, tz) {
  const d = new Date(`${tag}T12:00:00Z`);
  const teile = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(d);
  const name = teile.find((t) => t.type === 'timeZoneName').value; // "GMT+02:00" oder "GMT"
  return name === 'GMT' ? '+00:00' : name.replace('GMT', '');
}

// ---------- Shopify ----------

async function shopifyToken(shop) {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env('SHOPIFY_CLIENT_ID'),
      client_secret: env('SHOPIFY_CLIENT_SECRET'),
    }),
  });
  if (!res.ok) throw new Error(`Shopify Token: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

function shopifyClient(shop, token) {
  return async (query, variables = {}) => {
    const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (!res.ok || json.errors) throw new Error(`Shopify GraphQL: ${res.status} ${JSON.stringify(json.errors || json)}`);
    return json.data;
  };
}

// Bestellungen pro Tag (ohne Testbestellungen und Stornos)
async function shopifyBestellungen(gql, tage, tz) {
  const ergebnis = Object.fromEntries(tage.map((t) => [t, { bestellungen: 0, umsatz: 0 }]));
  const von = `${tage[0]}T00:00:00${versatz(tage[0], tz)}`;
  const bisTag = plusTage(tage.at(-1), 1);
  const bis = `${bisTag}T00:00:00${versatz(bisTag, tz)}`;
  const tagVon = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });

  let cursor = null;
  do {
    const data = await gql(`query($q: String!, $after: String) {
      orders(first: 250, after: $after, query: $q, sortKey: CREATED_AT) {
        nodes { createdAt test cancelledAt currentTotalPriceSet { shopMoney { amount } } }
        pageInfo { hasNextPage endCursor }
      }
    }`, { q: `created_at:>='${von}' AND created_at:<'${bis}'`, after: cursor });
    for (const o of data.orders.nodes) {
      if (o.test || o.cancelledAt) continue;
      const tag = tagVon.format(new Date(o.createdAt));
      if (!ergebnis[tag]) continue;
      ergebnis[tag].bestellungen += 1;
      ergebnis[tag].umsatz += Number(o.currentTotalPriceSet.shopMoney.amount);
    }
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);
  return ergebnis;
}

// ShopifyQL liefert Tabellen; Zeilen koennen je nach API-Version Objekte oder Arrays sein
async function shopifyql(gql, abfrage) {
  const data = await gql(`query($q: String!) {
    shopifyqlQuery(query: $q) { tableData { columns { name dataType } rows } parseErrors }
  }`, { q: abfrage });
  const r = data.shopifyqlQuery;
  if (r.parseErrors && r.parseErrors.length) throw new Error(`ShopifyQL: ${JSON.stringify(r.parseErrors)}`);
  const spalten = r.tableData.columns.map((c) => c.name);
  return r.tableData.rows.map((zeile) => {
    const z = typeof zeile === 'string' ? JSON.parse(zeile) : zeile;
    return Array.isArray(z) ? Object.fromEntries(spalten.map((s, i) => [s, z[i]])) : z;
  });
}

// Besucher pro Tag. Probiert mehrere Schreibweisen, weil ShopifyQL sich zwischen Versionen geaendert hat.
async function shopifyBesucher(gql, tage) {
  const zeitraum = `SINCE ${tage[0]} UNTIL ${tage.at(-1)}`;
  const versuche = [
    `FROM sessions SHOW sessions, online_store_visitors TIMESERIES day ${zeitraum}`,
    `FROM sessions SHOW sessions, online_store_visitors GROUP BY day ${zeitraum} ORDER BY day`,
    `FROM sessions SHOW sessions TIMESERIES day ${zeitraum}`,
    `FROM sessions SHOW sessions GROUP BY day ${zeitraum} ORDER BY day`,
  ];
  let letzterFehler;
  for (const abfrage of versuche) {
    try {
      const zeilen = await shopifyql(gql, abfrage);
      const ergebnis = {};
      for (const z of zeilen) {
        const tag = String(z.day || z.Day || '').slice(0, 10);
        if (!tag) continue;
        ergebnis[tag] = {
          sitzungen: Number(z.sessions ?? 0),
          besucher: z.online_store_visitors != null ? Number(z.online_store_visitors) : null,
        };
      }
      return ergebnis;
    } catch (e) {
      letzterFehler = e;
    }
  }
  console.warn(`Besucherzahlen nicht abrufbar: ${letzterFehler?.message}`);
  return {};
}

// ---------- Meta ----------

const KAUF_TYPEN = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
function kaufWert(liste) {
  if (!Array.isArray(liste)) return 0;
  for (const typ of KAUF_TYPEN) {
    const treffer = liste.find((a) => a.action_type === typ);
    if (treffer) return Number(treffer.value);
  }
  return 0;
}

async function metaAlle(url) {
  const zeilen = [];
  let naechste = url;
  while (naechste) {
    const res = await fetch(naechste);
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(`Meta: ${res.status} ${JSON.stringify(json.error || json)}`);
    zeilen.push(...json.data);
    naechste = json.paging?.next || null;
  }
  return zeilen;
}

async function metaInsights(tage) {
  let konto = env('META_AD_ACCOUNT_ID');
  if (!konto.startsWith('act_')) konto = `act_${konto}`;
  const parameter = (level) => new URLSearchParams({
    level,
    time_increment: '1',
    time_range: JSON.stringify({ since: tage[0], until: tage.at(-1) }),
    fields: 'campaign_name,spend,impressions,clicks,inline_link_clicks,actions,action_values',
    limit: '500',
    access_token: env('META_ACCESS_TOKEN'),
  });
  const basis = `https://graph.facebook.com/${META_API}/${konto}/insights`;

  const zuWerten = (z) => ({
    ausgaben: Number(z.spend || 0),
    kaeufe: kaufWert(z.actions),
    umsatz: kaufWert(z.action_values),
    impressionen: Number(z.impressions || 0),
    linkklicks: Number(z.inline_link_clicks || 0),
  });

  const konten = await metaAlle(`${basis}?${parameter('account')}`);
  const proTag = {};
  for (const z of konten) proTag[z.date_start] = zuWerten(z);

  const kampagnen = {};
  for (const z of await metaAlle(`${basis}?${parameter('campaign')}`)) {
    (kampagnen[z.date_start] ||= []).push({ name: z.campaign_name, ...zuWerten(z) });
  }
  return { proTag, kampagnen };
}

// ---------- Ablauf ----------

async function main() {
  const passwort = env('DASHBOARD_PASSWORT');
  const shop = env('SHOPIFY_SHOP');

  let bestand = { tage: {}, kampagnen: {} };
  try {
    bestand = await entschluesseln(JSON.parse(await readFile(DATEI, 'utf8')), passwort);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`Bestehende Daten nicht lesbar, fange neu an: ${e.message}`);
  }

  const gql = shopifyClient(shop, await shopifyToken(shop));
  const { shop: info } = await gql('{ shop { name ianaTimezone currencyCode } }');
  const tz = info.ianaTimezone;

  const anzahl = Number(env('TAGE', false)) || (Object.keys(bestand.tage).length ? 3 : 30);
  const gestern = plusTage(heuteIn(tz), -1);
  const tage = Array.from({ length: anzahl }, (_, i) => plusTage(gestern, i - anzahl + 1));
  console.log(`Hole ${tage[0]} bis ${tage.at(-1)} (${tz})`);

  const bestellungen = await shopifyBestellungen(gql, tage, tz);
  const besucher = await shopifyBesucher(gql, tage);

  let meta = null;
  if (env('META_ACCESS_TOKEN', false) && env('META_AD_ACCOUNT_ID', false)) {
    meta = await metaInsights(tage);
  } else {
    console.log('Meta-Zugang noch nicht hinterlegt, ueberspringe Meta.');
  }

  for (const tag of tage) {
    const alt = bestand.tage[tag] || {};
    bestand.tage[tag] = {
      shop: { ...bestellungen[tag], ...(besucher[tag] || alt.shop && { sitzungen: alt.shop.sitzungen, besucher: alt.shop.besucher }) },
      meta: meta ? (meta.proTag[tag] || { ausgaben: 0, kaeufe: 0, umsatz: 0, impressionen: 0, linkklicks: 0 }) : alt.meta || null,
    };
    if (meta) bestand.kampagnen[tag] = meta.kampagnen[tag] || [];
  }

  bestand.shopName = info.name;
  bestand.waehrung = info.currencyCode;
  bestand.zeitzone = tz;
  bestand.aktualisiert = new Date().toISOString();

  await writeFile(DATEI, JSON.stringify(await verschluesseln(bestand, passwort)) + '\n');
  const g = bestand.tage[gestern];
  console.log(`Fertig. Gestern: ${g.shop.bestellungen} Bestellungen, ${g.shop.sitzungen ?? '?'} Sitzungen, Meta ${g.meta ? g.meta.ausgaben + ' ' + bestand.waehrung : 'fehlt'}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
