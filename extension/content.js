// content.js — roda dentro da página de carrinho/checkout.
//
// O que ele faz, em ordem:
//   1. Acha o campo de cupom na página (lista de seletores conhecidos de
//      VTEX, Shopify, Mercado Livre, Magalu, Carrefour, Amazon + fallback
//      genérico).
//   2. Pra cada cupom candidato: escreve o código no campo simulando um
//      evento de input "de verdade" (necessário pra React/Vue/Angular
//      reconhecerem o valor — ver setNativeValue), aciona o botão de aplicar
//      e observa o DOM em busca de um sinal de sucesso ou erro.
//   3. Guarda o cupom que deu o maior desconto detectado e deixa ele
//      aplicado no final.
//
// Limitação honesta: cada loja implementa isso de um jeito. Os seletores e
// padrões de texto abaixo cobrem os casos mais comuns, mas não têm como
// cobrir 100% dos sites — se não funcionar num site específico, normalmente
// dá pra resolver adicionando o seletor certo nas listas abaixo (veja o
// README, seção "Ajustando pra um site específico").

(() => {
  const COUPON_INPUT_SELECTORS = [
    // Genéricos
    "#coupon",
    "#cupom",
    "#promo-code",
    "#promoCode",
    'input[name="coupon"]',
    'input[name="cupom"]',
    'input[name="promoCode"]',
    'input[name="promo_code"]',
    'input[name="voucher"]',
    'input[id*="coupon" i]',
    'input[id*="cupom" i]',
    'input[id*="promo" i]',
    'input[id*="voucher" i]',
    'input[placeholder*="cupom" i]',
    'input[placeholder*="coupon" i]',
    'input[placeholder*="código" i]',
    'input[placeholder*="promo" i]',
    ".coupon-input input",
    ".cupom-input input",
    ".promo-code-input input",
    ".coupon-input",
    ".cupom-input",
    // VTEX (várias lojas .com.br usam VTEX IO ou VTEX legado)
    ".vtex-checkout-summary .coupon input",
    'input[class*="couponCode" i]',
    'input[class*="cupomCodigo" i]',
    // Shopify
    'input[name="discount"]',
    "input#discount_code",
    'input[name="checkout[reduction_code]"]',
    // Padrões comuns em Mercado Livre / Magalu / Carrefour / Amazon
    'input[data-testid*="coupon" i]',
    'input[data-testid*="cupom" i]',
    'input[name="couponCode"]',
    "input#couponCode",
    'input[name="gift-card-or-promotion-code"]',
  ];

  const APPLY_TEXT_PATTERNS = [
    "aplicar",
    "apply",
    "usar cupom",
    "adicionar cupom",
    "confirmar",
    "add",
    "ok",
  ];

  const TOTAL_SELECTORS = [
    '[data-testid*="total" i]',
    '[class*="total-price" i]',
    '[class*="cart-total" i]',
    '[class*="order-total" i]',
    '[class*="grand-total" i]',
    '[id*="total" i]',
    ".summary-total",
    ".order-total",
    ".grand-total",
  ];

  const SUCCESS_TEXT_PATTERN =
    /cupom aplicado|desconto aplicado|coupon applied|código aplicado|promoção aplicada|cupom adicionado/i;
  const ERROR_TEXT_PATTERN =
    /cupom inv[aá]lido|cupom expirado|c[oó]digo inv[aá]lido|invalid coupon|não foi poss[ií]vel aplicar|cupom não encontrado|cupom já utilizado/i;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisible(el) {
    return !!el && el.offsetParent !== null;
  }

  // Escreve o valor usando o setter NATIVO do input (não o que React/Vue
  // sobrescrevem), e dispara input/change reais. É assim que frameworks
  // "controlled" reconhecem uma mudança de valor feita por código em vez de
  // digitação manual — sem isso, o campo mostra o texto mas o estado interno
  // do framework continua vazio, e o clique em "aplicar" manda o valor antigo.
  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    const nativeSetter = descriptor && descriptor.set;

    if (nativeSetter) {
      nativeSetter.call(element, value);
    } else {
      element.value = value;
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findCouponInput() {
    for (const sel of COUPON_INPUT_SELECTORS) {
      const el = document.querySelector(sel);
      if (isVisible(el)) return el;
    }
    return null;
  }

  function findApplyButton(input) {
    const scopes = [];
    if (input.form) scopes.push(input.form);

    let parent = input.parentElement;
    for (let i = 0; i < 4 && parent; i++) {
      scopes.push(parent);
      parent = parent.parentElement;
    }

    for (const scope of scopes) {
      const clickable = scope.querySelectorAll(
        'button, input[type="submit"], a[role="button"]'
      );
      for (const el of clickable) {
        const text = (el.textContent || el.value || "").trim().toLowerCase();
        if (APPLY_TEXT_PATTERNS.some((p) => text.includes(p))) {
          return el;
        }
      }
    }
    return null;
  }

  function parseCurrency(text) {
    if (!text) return null;
    const cleaned = text.replace(/\./g, "").replace(",", ".");
    const match = cleaned.match(/(\d+(\.\d+)?)/);
    return match ? parseFloat(match[1]) : null;
  }

  function readTotalNearby() {
    for (const sel of TOTAL_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) {
        const value = parseCurrency(el.textContent);
        if (value !== null) return value;
      }
    }
    return null;
  }

  function waitForFeedback(timeoutMs) {
    return new Promise((resolve) => {
      const checkText = () => {
        const bodyText = document.body.innerText;
        if (SUCCESS_TEXT_PATTERN.test(bodyText)) return "success";
        if (ERROR_TEXT_PATTERN.test(bodyText)) return "error";
        return null;
      };

      const immediate = checkText();
      if (immediate) {
        resolve(immediate);
        return;
      }

      const observer = new MutationObserver(() => {
        const result = checkText();
        if (result) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(result);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      const timer = setTimeout(() => {
        observer.disconnect();
        resolve("timeout");
      }, timeoutMs);
    });
  }

  async function testCoupon(input, applyButton, code, config) {
    setNativeValue(input, code);
    await sleep(150);

    if (applyButton) {
      applyButton.click();
    } else if (input.form && typeof input.form.requestSubmit === "function") {
      input.form.requestSubmit();
    } else if (input.form) {
      input.form.submit();
    } else {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    }

    return waitForFeedback(config.feedbackTimeoutMs);
  }

  async function runCouponTest(candidates, config, onProgress) {
    const input = findCouponInput();
    if (!input) {
      return { ok: false, reason: "campo-nao-encontrado" };
    }

    const applyButton = findApplyButton(input);
    const baselineTotal = readTotalNearby();

    const results = [];
    let best = null;

    for (const coupon of candidates) {
      onProgress?.({ status: "testando", code: coupon.code });

      const outcome = await testCoupon(input, applyButton, coupon.code, config);
      const totalAfter = readTotalNearby();
      const discountDetected =
        baselineTotal !== null && totalAfter !== null
          ? Math.round((baselineTotal - totalAfter) * 100) / 100
          : null;

      const result = {
        code: coupon.code,
        store: coupon.store,
        outcome,
        discountDetected,
      };
      results.push(result);
      onProgress?.({ status: "resultado", result });

      if (outcome === "success") {
        const currentBestValue = best?.discountDetected ?? -Infinity;
        const thisValue = discountDetected ?? 0;
        if (!best || thisValue > currentBestValue) {
          best = result;
        }
      }

      await sleep(config.delayBetweenMs);
    }

    // Se o último cupom testado não foi o melhor, reaplica o melhor no final
    // pra deixar o carrinho com o desconto máximo, não só o último tentado.
    if (best && results[results.length - 1]?.code !== best.code) {
      await testCoupon(input, applyButton, best.code, config);
    }

    return { ok: true, results, best };
  }

  function getCandidateCoupons(storedCoupons, privateCoupons) {
    const host = location.hostname.replace(/^www\./, "");

    const privateAsCandidates = privateCoupons.map((code) => ({
      code,
      store: "meu cupom",
    }));

    const matching = (storedCoupons || []).filter((c) => {
      if (!c.store_domains || c.store_domains.length === 0) return true;
      return c.store_domains.some((d) => host.includes(d.replace(/^www\./, "")));
    });

    const withDomain = matching.filter((c) => c.store_domains?.length);
    const withoutDomain = matching.filter((c) => !c.store_domains?.length);

    return [...privateAsCandidates, ...withDomain, ...withoutDomain];
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "RUN_TEST") return false;

    (async () => {
      const { coupons = [] } = await chrome.storage.local.get("coupons");
      const { privateCoupons = [] } = await chrome.storage.local.get(
        "privateCoupons"
      );
      const candidates = getCandidateCoupons(coupons, privateCoupons);

      if (candidates.length === 0) {
        sendResponse({ ok: false, reason: "sem-cupons-para-este-site" });
        return;
      }

      const config = {
        delayBetweenMs: message.delayMs ?? 1200,
        feedbackTimeoutMs: message.feedbackTimeoutMs ?? 3500,
      };

      const outcome = await runCouponTest(candidates, config, (progress) => {
        chrome.runtime
          .sendMessage({ type: "TEST_PROGRESS", progress })
          .catch(() => {});
      });

      sendResponse(outcome);
    })();

    return true; // resposta assíncrona
  });
})();
