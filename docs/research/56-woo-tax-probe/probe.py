"""The JSON half of probe.sh: builds the order bodies and prints what the shop
answered. Reads files and arguments only; it calls nothing."""

import json
import sys
from decimal import ROUND_HALF_UP, Decimal


def money(minor):
    return f"{int(minor or 0) / 100:.2f}"


def prices(path, label, kept):
    p = json.load(open(path))["prices"]
    print(f"  price {label}: wc/v3 price {kept}, store prices.price {money(p['price'])}")


def kept_price(path):
    print(json.load(open(path))["price"])


def cart(path, out):
    c = json.load(open(path))
    if "code" in c:
        print("  cart error", c["code"], c.get("message"))
        json.dump({"total": None, "rate": None}, open(out, "w"))
        return
    t = c["totals"]
    rates = [r for pkg in c.get("shipping_rates", []) for r in pkg["shipping_rates"]]
    cheap = min(rates, key=lambda r: int(r["price"])) if rates else None
    line = c["items"][0]
    tax_lines = [(x["name"], x["rate"], money(x["price"])) for x in t.get("tax_lines", [])]
    print(
        f"  cart: items {money(t['total_items'])} +tax {money(t['total_items_tax'])}"
        f" | shipping {money(t['total_shipping'])} +tax {money(t['total_shipping_tax'])}"
        f" | total_tax {money(t['total_tax'])} | total_price {money(t['total_price'])}"
        f" | tax_lines {tax_lines}"
    )
    print(
        f"  cart line: prices.price {money(line['prices']['price'])}"
        f" line_subtotal {money(line['totals']['line_subtotal'])}"
        f" line_subtotal_tax {money(line['totals']['line_subtotal_tax'])}"
    )
    rate = None
    if cheap:
        print(
            f"  cheapest rate: {cheap['method_id']}:{cheap['instance_id']} {cheap['name']}"
            f" price {money(cheap['price'])} taxes {money(cheap['taxes'])}"
        )
        rate = {
            "method_id": cheap["method_id"],
            "instance_id": str(cheap["instance_id"]),
            "title": cheap["name"],
            "cost": money(cheap["price"]),
        }
    json.dump({"total": money(t["total_price"]), "rate": rate}, open(out, "w"))


def field(path, name):
    value = json.load(open(path))[name]
    print(json.dumps(value) if isinstance(value, (dict, list)) or value is None else value)


def order(path, expect, label, status):
    o = json.load(open(path))
    if "id" not in o:
        print(f"  {label}: HTTP {status} {o.get('code')}: {o.get('message')}")
        return
    line = o["line_items"][0]
    ship = o["shipping_lines"][0] if o["shipping_lines"] else None
    taxes = [(t["label"], t["rate_percent"], t["tax_total"], t["shipping_tax_total"]) for t in o["tax_lines"]]
    said = f"  {label}: order {o['id']} {o['status']} total {o['total']} total_tax {o['total_tax']}"
    said += f" | line subtotal {line['subtotal']} total {line['total']} total_tax {line['total_tax']}"
    if ship:
        said += f" | shipping {ship['total']} tax {ship['total_tax']}"
    said += f" | tax_lines {taxes} | against {expect}: {'EQUAL' if o['total'] == expect else 'differs'}"
    print(said)


def body(kind, pid, line_total, extra):
    line = {"product_id": int(pid), "quantity": 1}
    if line_total:
        line["subtotal"] = line_total
        line["total"] = line_total
    b = {
        "payment_method": "agentify",
        "payment_method_title": "Agentify",
        "transaction_id": "probe-" + kind,
        "set_paid": True,
        "currency": "USD",
        "billing": {"email": "merchant@example.com"},
        "meta_data": [{"key": "agentify_order_id", "value": "probe-" + kind}],
        "line_items": [line],
    }
    if extra:
        b.update(json.loads(extra))
    print(json.dumps(b))


def ex_tax(price, rate, quantum):
    print((Decimal(price) / (1 + Decimal(rate) / 100)).quantize(Decimal(quantum), rounding=ROUND_HALF_UP))


def goods_and_rate(goods, rate):
    print(Decimal(goods) + Decimal(json.loads(rate)["cost"]))


def parcel_lines(rate, country, state, city, postcode):
    r = json.loads(rate)
    shipping = {
        "first_name": "Probe Buyer",
        "address_1": "1 Probe Street",
        "address_2": "",
        "city": city,
        "state": state,
        "postcode": postcode,
        "country": country,
        "phone": "+10000000000",
    }
    print(json.dumps({
        "shipping": shipping,
        "shipping_lines": [{
            "method_id": r["method_id"],
            "instance_id": r["instance_id"],
            "method_title": r["title"],
            "total": r["cost"],
        }],
    }))


if __name__ == "__main__":
    globals()[sys.argv[1].replace("-", "_")](*sys.argv[2:])
