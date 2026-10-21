"""Inclusion and origin rules of the census note, applied to one screened candidate."""
import json, re

def text_of(html):
    html = re.sub(r"(?is)<(script|style|noscript|svg)\b.*?</\1>", " ", html)
    t = re.sub(r"(?s)<[^>]+>", " ", html)
    t = re.sub(r"&nbsp;|&#160;", " ", t)
    return re.sub(r"\s+", " ", t)

EU = {  # country: (ccTLD, calling codes, names)
    "AT": ("at", ["43"], ["Austria", "Österreich"]), "BE": ("be", ["32"], ["Belgium", "Belgique", "België"]),
    "BG": ("bg", ["359"], ["Bulgaria"]), "HR": ("hr", ["385"], ["Croatia", "Hrvatska"]), "CY": ("cy", ["357"], ["Cyprus"]),
    "CZ": ("cz", ["420"], ["Czech Republic", "Czechia", "Česká republika"]), "DK": ("dk", ["45"], ["Denmark", "Danmark"]),
    "EE": ("ee", ["372"], ["Estonia", "Eesti"]), "FI": ("fi", ["358"], ["Finland", "Suomi"]), "FR": ("fr", ["33"], ["France"]),
    "DE": ("de", ["49"], ["Germany", "Deutschland"]), "GR": ("gr", ["30"], ["Greece"]), "HU": ("hu", ["36"], ["Hungary", "Magyarország"]),
    "IE": ("ie", ["353"], ["Ireland"]), "IT": ("it", ["39"], ["Italy", "Italia"]), "LV": ("lv", ["371"], ["Latvia"]),
    "LT": ("lt", ["370"], ["Lithuania"]), "LU": ("lu", ["352"], ["Luxembourg"]), "MT": ("mt", ["356"], ["Malta"]),
    "NL": ("nl", ["31"], ["Netherlands", "Nederland", "The Netherlands"]), "PL": ("pl", ["48"], ["Poland", "Polska"]),
    "PT": ("pt", ["351"], ["Portugal"]), "RO": ("ro", ["40"], ["Romania", "România"]), "SK": ("sk", ["421"], ["Slovakia", "Slovensko"]),
    "SI": ("si", ["386"], ["Slovenia", "Slovenija"]), "ES": ("es", ["34"], ["Spain", "España"]), "SE": ("se", ["46"], ["Sweden", "Sverige"]),
    "GB": ("uk", ["44"], ["United Kingdom", "England", "Scotland", "Wales"]), "NO": ("no", ["47"], ["Norway", "Norge"]),
    "CH": ("ch", ["41"], ["Switzerland", "Schweiz", "Suisse", "Svizzera"]), "IS": ("is", ["354"], ["Iceland"]),
}
BALI = ["Bali", "Denpasar", "Badung", "Gianyar", "Tabanan", "Bangli", "Klungkung", "Karangasem", "Buleleng", "Jembrana",
        "Ubud", "Canggu", "Seminyak", "Kuta", "Legian", "Sanur", "Uluwatu", "Jimbaran", "Nusa Dua", "Kerobokan",
        "Pererenan", "Singaraja", "Amed", "Lovina"]
US_STATES = ["Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia","Wisconsin","Wyoming"]
US_ABBR = "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split()

ID_ADDRESS = re.compile(r"\b(Jl\.|Jln\.?|Jalan)\s+\w", re.I)
ID_PHONE = re.compile(r"(\+\s?62[\s\-.()]*\d|wa\.me/62|phone=62|phone=\+62|whatsapp\.com/send\?phone=62)", re.I)
ID_SCHEMA = re.compile(r'"addressCountry"\s*:\s*"(ID|Indonesia)"', re.I)
US_ADDR = re.compile(r"\b(" + "|".join(US_ABBR) + r")\s+\d{5}(-\d{4})?\b")
US_PHONE = re.compile(r"\+\s?1[\s\-.(]*\d{3}")
US_SCHEMA = re.compile(r'"addressCountry"\s*:\s*"(US|USA|United States)"', re.I)
EXCL_HOST = re.compile(r"(^|[.-])(demo|staging|dev|test)([.-]|$)", re.I)
CLOSED = re.compile(r"\b(coming soon|under maintenance|maintenance mode|segera hadir|sedang dalam perbaikan|permanently closed|we are closed|no longer trading|bientôt disponible|demnächst verfügbar|wartungsmodus)\b", re.I)

def address_windows(text):
    """Text around address markers: street words, postcodes, 'address'/'alamat' labels, phone numbers."""
    marks = [m.start() for m in re.finditer(r"(\b(Jl\.|Jln|Jalan|Address|Alamat|Adresse|Dirección|Indirizzo|Adres|Contact|Kontak|Hubungi)\b|\+\s?\d{2})", text, re.I)]
    return [text[max(0, i - 250): i + 250] for i in marks]

ID_PLACES = ["Indonesia", "Jakarta", "Bandung", "Surabaya", "Yogyakarta", "Jogja", "Semarang", "Medan", "Makassar", "Malang",
             "Surakarta", "Bogor", "Depok", "Tangerang", "Bekasi", "Lombok"] + BALI

def contacts(raw):
    """Numbers from tel: and WhatsApp links, which carry a calling code."""
    intl = re.findall(r'tel:\s*(?:\+|00)([0-9][0-9 ()\-.]{6,})', raw, re.I)
    return intl + re.findall(r'(?:wa\.me/|phone=)\s*\+?([0-9][0-9 ()\-.]{6,})', raw, re.I)

def origin(host, html, query_group, q):
    text = text_of(html)
    raw = html
    wins = address_windows(text)
    wtext = " ".join(wins)
    nums = [re.sub(r"\D", "", n) for n in contacts(raw)]
    bali_re = re.compile(r"\b(" + "|".join(BALI) + r")\b")
    id_place = re.compile(r"\b(" + "|".join(ID_PLACES) + r")\b")
    def indonesian(region_hint):
        if bali_re.search(wtext):
            return {"group": "ID", "region": "Bali", "how": region_hint + "; address names Bali"}
        has_street = bool(ID_ADDRESS.search(text) or ID_SCHEMA.search(raw))
        if not has_street and query_group == "B":
            return {"group": "ID", "region": "Bali", "how": region_hint + "; no street address; named by a Bali source"}
        return {"group": "ID", "region": "other", "how": region_hint}
    # Strong signals first: domain, calling code in contact links or text, structured or street address.
    if host.endswith(".id") or any(n.startswith("62") for n in nums) or re.search(r"\+\s?62[\s\-.()]*\d", text) or ID_SCHEMA.search(raw) \
            or (ID_ADDRESS.search(text) and id_place.search(wtext)):
        return indonesian("Indonesian contact, domain or street address")
    states = re.compile(r"\b(" + "|".join(US_STATES) + r")\b")
    us_phone = any(n.startswith("1") and len(n) == 11 for n in nums) or bool(re.search(r"\+\s?1[\s\-.(]*\d{3}", text))
    if US_ADDR.search(text) or US_SCHEMA.search(raw) or (us_phone and (states.search(wtext) or re.search(r",\s(" + "|".join(US_ABBR) + r")\b", wtext))):
        return {"group": "US", "how": "US address or +1 with state"}
    m = re.search(r'"addressCountry"\s*:\s*"([A-Za-z ]+)"', raw)
    if m:
        v = m.group(1).strip()
        for c, (tld, codes, names) in EU.items():
            if v.upper() in (c, "UK" if c == "GB" else c) or v in names:
                return {"group": "EU", "country": c, "how": "schema address"}
    postcode = r"(\b\d{4,5}\b|\b\d{4}\s?[A-Z]{2}\b|\b[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}\b|\b\d{2}-\d{3}\b)"
    for c, (tld, codes, names) in EU.items():
        if any(re.search(r"\b" + re.escape(n) + r"\b", wtext) for n in names) and re.search(postcode, wtext):
            return {"group": "EU", "country": c, "how": "address on front page"}
        # A postal address anywhere on the page: a postcode followed closely by the country's name.
        if any(re.search(postcode + r"\s+[A-Za-zÀ-ÿ'().\- ]{2,40}?\s*[,\-–|]\s*" + re.escape(n) + r"\b", text) for n in names):
            return {"group": "EU", "country": c, "how": "address on front page"}
    tld = host.rsplit(".", 1)[-1]
    for c, (t, codes, names) in EU.items():
        if tld == t:
            return {"group": "EU", "country": c, "how": "domain"}
    for c, (t, codes, names) in sorted(EU.items(), key=lambda kv: -max(len(x) for x in kv[1][1])):
        if any(n.startswith(code) for code in codes for n in nums if not n.startswith("1")) or any(re.search(r"\+\s?" + code + r"[\s\-.(]*\d", text) for code in codes):
            return {"group": "EU", "country": c, "how": "calling code"}
    # Weak: an Indonesian place named where the page gives its address or contact.
    if id_place.search(wtext):
        return indonesian("Indonesian place in the address or contact text")
    return {"group": None, "how": "origin undetermined"}

WOO_MARK = re.compile(r"/wp-content/plugins/woocommerce/|<body[^>]*class=[\"'][^\"']*\bwoocommerce\b", re.I)

def decide(rec, front_html, listing_json_count):
    """Returns dict(woo, included, reason, origin)."""
    host = rec.get("origin") or rec["cand"]["host"]
    hcls = rec.get("honest_class"); probe = (rec.get("probe") or {}).get("class")
    woo = (hcls in ("Readable", "Empty")) or probe in ("Readable", "Empty") or bool(WOO_MARK.search(front_html or ""))
    out = {"woo": woo}
    if not woo:
        if rec.get("stopped", "") in ("front Challenged", "front Rate-limited"):
            out.update(included=False, reason="blocked before identification")
        elif rec.get("stopped", "") == "robots disallows listing" and not front_html:
            out.update(included=False, reason="robots before identification")
        else:
            out.update(included=False, reason="not a WooCommerce shop")
        return out
    if EXCL_HOST.search(host.split(".")[0]) or EXCL_HOST.search(host):
        out.update(included=False, reason="host label demo/staging/dev/test"); return out
    title = re.search(r"(?is)<title[^>]*>(.*?)</title>", front_html or "")
    # A holding page says so in its title, or is a short page that says little else.
    body_text = text_of(front_html or "")
    if CLOSED.search(title.group(1) if title else "") or (len(body_text) < 1500 and CLOSED.search(body_text)):
        out.update(included=False, reason="coming soon, maintenance or closed"); return out
    if hcls == "Empty" or (hcls not in ("Readable",) and probe == "Empty"):
        out.update(included=False, reason="no products in the listing"); return out
    o = origin(host, front_html or "", rec["cand"]["stratum"], rec["cand"]["q"])
    out["origin"] = o
    if o["group"] is None:
        out.update(included=False, reason="origin undetermined"); return out
    out.update(included=True, reason="included")
    return out
