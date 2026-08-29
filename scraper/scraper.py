#!/usr/bin/env python3
"""
scraper.py — Coleta cupons de desconto de fontes configuráveis e gera cupons.json.

Uso:
    python scraper.py

Lê a configuração de fontes em `sources.json` (mesma pasta), raspa cada fonte
habilitada, aplica um filtro de "visto pela primeira vez nas últimas
HOURS_WINDOW horas", faz merge com o `docs/cupons.json` anterior (se existir)
e escreve o resultado final ali — pasta que o GitHub Pages publica.

Dependência propositalmente mínima (`requests` + `beautifulsoup4`, sem
Selenium/Playwright) para caber no runner padrão do GitHub Actions sem
precisar instalar navegador nenhum.

IMPORTANTE — leia antes de usar de verdade:
  1. Os seletores CSS em sources.json são ilustrativos. Cada site muda o HTML
     com o tempo, então inspecione a página real (botão direito > Inspecionar)
     antes de habilitar uma fonte (`"enabled": true`).
  2. Fontes do tipo "community" (ex.: agregadores como o Pelando) publicam
     conteúdo enviado por usuários e costumam ter proteção anti-bot e termos
     de uso que restringem coleta automatizada em escala. Rodar isso hora em
     hora contra um site desses tende a ser bloqueado rápido e pode conflitar
     com os termos de uso dele. Prefira páginas oficiais de cupom das
     próprias lojas (tipo "official_store") como fonte principal, e trate
     fontes de comunidade como algo opcional, de baixa frequência, ou apenas
     para consulta manual.
"""

from __future__ import annotations

import json
import re
import sys
import time
import unicodedata
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import requests
from bs4 import BeautifulSoup

# --------------------------------------------------------------------------
# Configuração
# --------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
SOURCES_FILE = BASE_DIR / "sources.json"
STATE_FILE = BASE_DIR / ".state.json"                     # histórico interno (first_seen)
OUTPUT_FILE = BASE_DIR.parent / "docs" / "cupons.json"     # publicado no GitHub Pages

HOURS_WINDOW = 48           # janela de "cupom recente" (24–48h, pedido no briefing)
REQUEST_TIMEOUT = 15        # segundos
REQUEST_DELAY = 1.5         # segundos entre requests, pra não martelar o servidor
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 CupomPessoalBot/1.0 "
    "(+uso pessoal, sem redistribuicao)"
)

MONTHS_PT = {
    "jan": 1, "fev": 2, "mar": 3, "abr": 4, "mai": 5, "jun": 6,
    "jul": 7, "ago": 8, "set": 9, "out": 10, "nov": 11, "dez": 12,
}


# --------------------------------------------------------------------------
# Modelo de dados
# --------------------------------------------------------------------------

@dataclass
class Coupon:
    id: str
    store: str
    store_domains: list
    code: str
    description: str
    discount_type: str          # "percent" | "fixed" | "unknown"
    discount_value: Optional[float]
    source_url: str
    first_seen: str
    last_confirmed: str


# --------------------------------------------------------------------------
# Utilidades
# --------------------------------------------------------------------------

def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text or "loja"


def parse_relative_date_pt(text: str, reference: datetime) -> Optional[datetime]:
    """Tenta interpretar datas relativas/absolutas comuns em português
    ("há 2 horas", "hoje", "18 de ago", "18/08/2026" etc).

    Retorna None se não reconhecer o formato — nesse caso o chamador deve
    usar o fallback de `first_seen` em vez de descartar o cupom de cara.
    """
    if not text:
        return None
    t = text.strip().lower()

    if "agora" in t:
        return reference

    m = re.search(r"há\s+(\d+)\s*min", t)
    if m:
        return reference - timedelta(minutes=int(m.group(1)))

    m = re.search(r"há\s+(\d+)\s*h", t)
    if m:
        return reference - timedelta(hours=int(m.group(1)))

    m = re.search(r"há\s+(\d+)\s*dia", t)
    if m:
        return reference - timedelta(days=int(m.group(1)))

    if "hoje" in t:
        return reference

    if "ontem" in t:
        return reference - timedelta(days=1)

    m = re.search(r"(\d{1,2})\s+de\s+([a-zç]{3})", t)
    if m:
        day = int(m.group(1))
        mon = MONTHS_PT.get(m.group(2)[:3])
        if mon:
            year = reference.year
            try:
                candidate = datetime(year, mon, day, tzinfo=timezone.utc)
            except ValueError:
                return None
            if candidate > reference + timedelta(days=1):
                candidate = candidate.replace(year=year - 1)
            return candidate

    m = re.search(r"(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?", t)
    if m:
        day, mon = int(m.group(1)), int(m.group(2))
        year = int(m.group(3)) if m.group(3) else reference.year
        if year < 100:
            year += 2000
        try:
            return datetime(year, mon, day, tzinfo=timezone.utc)
        except ValueError:
            return None

    return None


def parse_discount(text: str):
    """Extrai '10% off' -> ('percent', 10.0); 'R$ 50 off' -> ('fixed', 50.0)."""
    if not text:
        return "unknown", None
    t = text.replace(",", ".")
    m = re.search(r"(\d+(?:\.\d+)?)\s*%", t)
    if m:
        return "percent", float(m.group(1))
    m = re.search(r"r\$\s*(\d+(?:\.\d+)?)", t.lower())
    if m:
        return "fixed", float(m.group(1))
    return "unknown", None


def load_json(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"[aviso] {path} corrompido, ignorando.", file=sys.stderr)
    return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# --------------------------------------------------------------------------
# Scraping de uma fonte
# --------------------------------------------------------------------------

def fetch(url: str):
    try:
        resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        return BeautifulSoup(resp.text, "html.parser")
    except requests.RequestException as exc:
        print(f"[erro] falha ao buscar {url}: {exc}", file=sys.stderr)
        return None


def scrape_source(source: dict, state: dict, reference: datetime):
    """
    `source` (vindo de sources.json) espera as chaves:
      name, url, type ("official_store" | "community"),
      item_selector, code_selector, desc_selector (opcional),
      date_selector (opcional), store_selector (opcional, só p/ "community"),
      domain (só p/ "official_store"), store_domain_map (opcional, p/ "community")
    """
    soup = fetch(source["url"])
    if soup is None:
        return []

    items = soup.select(source["item_selector"])
    results = []

    for item in items:
        code_el = item.select_one(source["code_selector"])
        if not code_el:
            continue
        code = re.sub(r"\s+", "", code_el.get_text(strip=True).upper())
        if not code or len(code) > 30:
            continue

        desc_sel = source.get("desc_selector")
        desc_el = item.select_one(desc_sel) if desc_sel else None
        description = desc_el.get_text(strip=True) if desc_el else ""

        date_sel = source.get("date_selector")
        date_el = item.select_one(date_sel) if date_sel else None
        parsed_date = parse_relative_date_pt(date_el.get_text(strip=True), reference) if date_el else None

        if source["type"] == "official_store":
            store = source["name"]
            domains = [source["domain"]]
        else:
            store_sel = source.get("store_selector")
            store_el = item.select_one(store_sel) if store_sel else None
            store = store_el.get_text(strip=True) if store_el else source["name"]
            domains = source.get("store_domain_map", {}).get(store, [])

        key = f"{slugify(store)}:{code}"
        prior = state.get(key)
        first_seen = prior["first_seen"] if prior else iso(reference)

        # Janela de frescor: usa a data da própria página quando dá pra
        # interpretar; cai pro "primeira vez que o NOSSO scraper viu esse
        # código" quando a página não tem data parseável.
        effective_date = parsed_date if parsed_date else parse_iso(first_seen)
        if reference - effective_date > timedelta(hours=HOURS_WINDOW):
            continue

        discount_type, discount_value = parse_discount(description)
        state[key] = {"first_seen": first_seen}

        results.append(Coupon(
            id=key,
            store=store,
            store_domains=domains,
            code=code,
            description=description or "Sem descrição disponível",
            discount_type=discount_type,
            discount_value=discount_value,
            source_url=source["url"],
            first_seen=first_seen,
            last_confirmed=iso(reference),
        ))

    return results


# --------------------------------------------------------------------------
# Execução principal
# --------------------------------------------------------------------------

def main() -> int:
    reference = now_utc()

    sources_doc = load_json(SOURCES_FILE, {})
    sources = sources_doc.get("sources", [])
    if not sources:
        print(f"[erro] nenhuma fonte configurada em {SOURCES_FILE}", file=sys.stderr)
        return 1

    state = load_json(STATE_FILE, {})
    previous_output = load_json(OUTPUT_FILE, {"coupons": []})
    previous_by_id = {c["id"]: c for c in previous_output.get("coupons", [])}

    all_coupons = {}
    any_enabled = False

    for source in sources:
        if not source.get("enabled", False):
            print(f"[info] pulando fonte desabilitada: {source['name']}")
            continue

        any_enabled = True
        print(f"[info] raspando: {source['name']} ({source['url']})")
        found = scrape_source(source, state, reference)
        print(f"[info]   {len(found)} cupom(ns) dentro da janela de {HOURS_WINDOW}h")

        for coupon in found:
            all_coupons[coupon.id] = coupon

        time.sleep(REQUEST_DELAY)

    if not any_enabled:
        print(
            "[aviso] nenhuma fonte está habilitada (enabled: true) em sources.json — "
            "gerando cupons.json vazio. Veja o README para configurar suas fontes.",
            file=sys.stderr,
        )

    # Mantém no arquivo final qualquer cupom antigo ainda dentro da janela de
    # frescor mesmo que a fonte não tenha sido re-raspada com sucesso nesta
    # execução (ex.: request falhou), pra não esvaziar o arquivo por causa de
    # uma falha pontual de rede.
    for cid, old in previous_by_id.items():
        if cid in all_coupons:
            continue
        try:
            last_confirmed = parse_iso(old["last_confirmed"])
        except (KeyError, ValueError):
            continue
        if reference - last_confirmed <= timedelta(hours=HOURS_WINDOW):
            all_coupons[cid] = Coupon(**old)

    ordered = sorted(all_coupons.values(), key=lambda c: c.last_confirmed, reverse=True)
    output = {
        "generated_at": iso(reference),
        "window_hours": HOURS_WINDOW,
        "count": len(ordered),
        "coupons": [asdict(c) for c in ordered],
    }

    save_json(OUTPUT_FILE, output)
    save_json(STATE_FILE, state)

    print(f"[ok] {output['count']} cupons escritos em {OUTPUT_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
