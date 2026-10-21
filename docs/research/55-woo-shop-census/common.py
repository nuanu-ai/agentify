import re
from urllib.parse import urlsplit
SLD = {"co","com","net","org","or","web","my","ac","go","sch","gov","biz","id","ltd","plc"}
def regdom(host):
    host=(host or "").lower().strip(".")
    if host.startswith("www."): host=host[4:]
    parts=host.split(".")
    if len(parts)>=3 and len(parts[-1])==2 and parts[-2] in SLD:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])
EXCLUDED = re.compile(r"(^|\.)(" + "|".join([
 r"facebook\.com", r"fb\.com", r"fb\.me", r"instagram\.com", r"instagr\.am", r"tiktok\.com", r"x\.com", r"twitter\.com", r"t\.co",
 r"pinterest\.[a-z.]+", r"pin\.it", r"youtube\.com", r"youtu\.be", r"linkedin\.com", r"lnkd\.in", r"t\.me", r"telegram\.(me|org)",
 r"wa\.me", r"whatsapp\.com", r"threads\.net", r"snapchat\.com", r"vimeo\.com", r"spotify\.com", r"soundcloud\.com", r"reddit\.com", r"tumblr\.com", r"flickr\.com", r"line\.me",
 r"shopee\.[a-z.]+", r"shp\.ee", r"tokopedia\.(com|link)", r"tkp\.me", r"lazada\.[a-z.]+", r"blibli\.com", r"bukalapak\.com", r"etsy\.com", r"amazon\.[a-z.]+", r"amzn\.to",
 r"ebay\.[a-z.]+", r"faire\.com", r"zalora\.[a-z.]+",
 r"maps\.google\.[a-z.]+", r"maps\.app\.goo\.gl", r"goo\.gl", r"g\.page", r"tripadvisor\.[a-z.]+", r"booking\.com", r"agoda\.com", r"klook\.com",
 r"traveloka\.com", r"airbnb\.[a-z.]+",
 r"google\.[a-z.]+", r"bing\.com", r"yahoo\.[a-z.]+", r"duckduckgo\.com", r"yandex\.[a-z.]+",
 r"googleapis\.com", r"gstatic\.com", r"googletagmanager\.com", r"google-analytics\.com", r"doubleclick\.net", r"googlesyndication\.com",
 r"googleadservices\.com", r"cloudflare\.com", r"cloudflareinsights\.com", r"jsdelivr\.net", r"unpkg\.com", r"jquery\.com", r"bootstrapcdn\.com",
 r"gravatar\.com", r"wp\.com", r"w\.org", r"wordpress\.org", r"wordpress\.com", r"schema\.org", r"w3\.org", r"ogp\.me", r"typekit\.net",
 r"fontawesome\.com", r"cdninstagram\.com", r"fbcdn\.net", r"addtoany\.com", r"sharethis\.com", r"disqus\.com", r"apple\.com", r"play\.google\.com",
]) + r")$", re.I)
def excluded(host):
    return bool(EXCLUDED.search((host or "").lower()))
UA_HONEST = "AgentifyResearch/1.0 (WooCommerce shop census; +https://agentify.ad)"
