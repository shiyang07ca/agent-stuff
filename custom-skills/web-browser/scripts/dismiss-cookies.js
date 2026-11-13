#!/usr/bin/env node

/**
 * Cookie 同意弹窗自动关闭工具
 *
 * 自动接受欧盟网站上的 cookie 同意弹窗。
 * 支持常见 CMP：OneTrust、Cookiebot、Didomi、Quantcast、Google、BBC、Amazon 等。
 *
 * 用法：
 *   ./dismiss-cookies.js --tab <targetId>          # 接受 cookie
 *   ./dismiss-cookies.js --tab <targetId> --reject # 拒绝 cookie（在可行时）
 */

import { parseCommand, run, withConnection, attachTab } from "./cli.js";

const DEBUG = process.env.DEBUG === "1";
const log = DEBUG ? (...args) => console.error("[debug]", ...args) : () => {};

const COOKIE_DISMISS_SCRIPT = `(acceptCookies) => {
  const clicked = [];

  const isVisible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' &&
           style.visibility !== 'hidden' &&
           style.opacity !== '0' &&
           (el.offsetParent !== null || style.position === 'fixed' || style.position === 'sticky');
  };

  const tryClick = (selector, description) => {
    const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (isVisible(el)) {
      el.click();
      clicked.push(description || selector);
      return true;
    }
    return false;
  };

  const findButtonByText = (patterns, container = document) => {
    const buttons = Array.from(container.querySelectorAll('button, [role="button"], a.button, input[type="submit"], input[type="button"]'));
    // 按长度降序排列模式，优先匹配更具体的模式
    const sortedPatterns = [...patterns].sort((a, b) => b.length - a.length);

    // 按具体程度（最长的优先）依次检查模式
    for (const pattern of sortedPatterns) {
      for (const btn of buttons) {
        const text = (btn.textContent || btn.value || '').trim().toLowerCase();
        if (text.length > 100) continue; // 跳过文本过长的按钮
        if (!isVisible(btn)) continue; // 跳过隐藏的按钮
        if (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)) {
          return btn;
        }
      }
    }
    return null;
  };

  const acceptPatterns = [
    'accept all', 'accept cookies', 'allow all', 'allow cookies',
    'i agree', 'i accept', 'yes, i agree', 'agree and continue',
    'alle akzeptieren', 'akzeptieren', 'alle zulassen', 'zustimmen',
    'annehmen', 'einverstanden',
    'accepter tout', 'tout accepter', "j'accepte", 'accepter et continuer', 'accepter',
    'accetta tutti', 'accetta', 'accetto',
    'aceptar todo', 'aceptar', 'acepto',
    'aceitar tudo', 'aceitar',
    'continue', 'agree',
  ];

  const rejectPatterns = [
    'reject all', 'decline all', 'deny all', 'refuse all',
    'i do not agree', 'i disagree', 'no thanks',
    'alle ablehnen', 'ablehnen', 'nicht zustimmen',
    'refuser tout', 'tout refuser', 'refuser',
    'rifiuta tutti', 'rifiuta',
    'rechazar todo', 'rechazar',
    'rejeitar tudo', 'rejeitar',
    'only necessary', 'necessary only', 'nur notwendige',
    'essential only', 'nur essentielle',
  ];

  const patterns = acceptCookies ? acceptPatterns : rejectPatterns;

  // OneTrust
  if (document.querySelector('#onetrust-banner-sdk')) {
    const selector = acceptCookies ? '#onetrust-accept-btn-handler' : '#onetrust-reject-all-handler';
    if (tryClick(selector, 'OneTrust')) return clicked;
  }

  // Google
  if (document.querySelector('[data-consent-dialog]') || document.querySelector('form[action*="consent.google"]') || document.querySelector('#CXQnmb')) {
    const selector = acceptCookies ? '#L2AGLb' : '#W0wltc';
    if (tryClick(selector, 'Google Consent')) return clicked;
  }

  // YouTube（Google 所有，自定义同意元素）
  if (document.querySelector('ytd-consent-bump-v2-lightbox')) {
    const btn = Array.from(document.querySelectorAll('ytd-consent-bump-v2-lightbox button'))
      .find(b => acceptCookies
        ? b.textContent.includes('Accept all') || b.ariaLabel?.includes('Accept')
        : b.textContent.includes('Reject all') || b.ariaLabel?.includes('Reject'));
    if (btn) {
      btn.click();
      clicked.push('YouTube');
      return clicked;
    }
  }

  // Cookiebot
  if (document.querySelector('#CybotCookiebotDialog')) {
    const selector = acceptCookies
      ? '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, #CybotCookiebotDialogBodyButtonAccept'
      : '#CybotCookiebotDialogBodyButtonDecline, #CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll';
    if (tryClick(selector, 'Cookiebot')) return clicked;
  }

  // Didomi
  if (document.querySelector('#didomi-host') || window.Didomi) {
    const selector = acceptCookies ? '#didomi-notice-agree-button' : '#didomi-notice-disagree-button, [data-testid="disagree-button"]';
    if (tryClick(selector, 'Didomi')) return clicked;
  }

  // Quantcast
  if (document.querySelector('.qc-cmp2-container')) {
    const selector = acceptCookies
      ? '.qc-cmp2-summary-buttons button[mode="primary"], .qc-cmp2-button[data-testid="accept-all"]'
      : '.qc-cmp2-summary-buttons button[mode="secondary"], .qc-cmp2-button[data-testid="reject-all"]';
    if (tryClick(selector, 'Quantcast')) return clicked;
  }

  // Usercentrics（shadow DOM）
  const ucRoot = document.querySelector('#usercentrics-root');
  if (ucRoot && ucRoot.shadowRoot) {
    const shadow = ucRoot.shadowRoot;
    const btn = acceptCookies
      ? shadow.querySelector('[data-testid="uc-accept-all-button"]')
      : shadow.querySelector('[data-testid="uc-deny-all-button"]');
    if (btn) { btn.click(); clicked.push('Usercentrics'); return clicked; }
  }

  // TrustArc
  if (document.querySelector('#truste-consent-track') || document.querySelector('.trustarc-banner')) {
    const selector = acceptCookies ? '#truste-consent-button, .trustarc-agree-btn' : '.trustarc-decline-btn';
    if (tryClick(selector, 'TrustArc')) return clicked;
  }

  // Klaro
  if (document.querySelector('.klaro')) {
    const selector = acceptCookies ? '.klaro .cm-btn-accept-all, .klaro .cm-btn-success' : '.klaro .cm-btn-decline';
    if (tryClick(selector, 'Klaro')) return clicked;
  }

  // BBC
  if (document.querySelector('#bbccookies, .bbccookies-banner')) {
    if (acceptCookies && tryClick('#bbccookies-continue-button', 'BBC')) return clicked;
  }

  // Amazon
  if (document.querySelector('#sp-cc') || document.querySelector('#sp-cc-accept')) {
    const selector = acceptCookies ? '#sp-cc-accept' : '#sp-cc-rejectall-link, #sp-cc-decline';
    if (tryClick(selector, 'Amazon')) return clicked;
  }

  // CookieYes
  if (document.querySelector('#cookie-law-info-bar') || document.querySelector('.cky-consent-container')) {
    const selector = acceptCookies ? '#cookie_action_close_header, .cky-btn-accept' : '.cky-btn-reject';
    if (tryClick(selector, 'CookieYes')) return clicked;
  }

  // 通用容器
  const consentContainers = [
    '[class*="cookie-banner"]', '[class*="cookie-consent"]', '[class*="cookie-notice"]',
    '[class*="cookieBanner"]', '[class*="cookieConsent"]', '[class*="cookieNotice"]',
    '[id*="cookie-banner"]', '[id*="cookie-consent"]', '[id*="cookie-notice"]',
    '[class*="consent-banner"]', '[class*="consent-modal"]', '[class*="consent-dialog"]',
    '[class*="gdpr"]', '[id*="gdpr"]', '[class*="privacy-banner"]', '[class*="privacy-notice"]',
    '[role="dialog"][aria-label*="cookie" i]', '[role="dialog"][aria-label*="consent" i]',
  ];

  for (const containerSel of consentContainers) {
    const containers = document.querySelectorAll(containerSel);
    for (const container of containers) {
      if (!isVisible(container)) continue;
      // 跳过可能匹配到的 html/body 元素
      if (container.tagName === 'HTML' || container.tagName === 'BODY') continue;
      const btn = findButtonByText(patterns, container);
      if (btn) { btn.click(); clicked.push('Generic (' + containerSel + ')'); return clicked; }
    }
  }

  // 最后手段：在 cookie 相关文本内容附近查找按钮
  // 查找提到 "cookie" 且带有 accept/reject 按钮的可见容器
  // 包括自定义元素（Reddit 使用 rpl-modal-card 等）
  const allContainers = document.querySelectorAll('div, section, aside, [class*="modal"], [class*="dialog"], [role="dialog"]');
  for (const container of allContainers) {
    if (!isVisible(container)) continue;
    const text = container.textContent?.toLowerCase() || '';
    // 必须提到 cookie 且尺寸合理（不是整个页面）
    if (text.includes('cookie') && text.length > 100 && text.length < 3000) {
      const btn = findButtonByText(patterns, container);
      if (btn && isVisible(btn)) {
        btn.click();
        clicked.push('Generic (text-based)');
        return clicked;
      }
    }
  }

  // 最终回退：查找任何可见且带有精确 accept/reject 文本的按钮
  // 该按钮需与页面上的 cookie 相关内容一同出现
  if (document.body.textContent?.toLowerCase().includes('cookie')) {
    const exactPatterns = acceptCookies
      ? ['accept all', 'accept cookies', 'allow all', 'i agree', 'alle akzeptieren']
      : ['reject all', 'decline all', 'reject optional', 'alle ablehnen'];
    const singleWordPatterns = acceptCookies ? ['accept', 'agree'] : ['reject', 'decline'];
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      if (!isVisible(btn)) continue;
      const text = (btn.textContent || '').trim().toLowerCase();
      if (exactPatterns.some(p => text.includes(p))) {
        btn.click();
        clicked.push('Generic (exact match)');
        return clicked;
      }
    }
    // 最后尝试单词匹配
    for (const btn of buttons) {
      if (!isVisible(btn)) continue;
      const text = (btn.textContent || '').trim().toLowerCase();
      if (singleWordPatterns.some(p => text === p)) {
        btn.click();
        clicked.push('Generic (word match)');
        return clicked;
      }
    }
  }

  return clicked;
}`;

const IFRAME_DISMISS_SCRIPT = `(acceptCookies) => {
  const clicked = [];

  const isVisible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' &&
           style.visibility !== 'hidden' &&
           style.opacity !== '0' &&
           (el.offsetParent !== null || style.position === 'fixed' || style.position === 'sticky');
  };

  const rejectIndicators = ['do not', "don't", 'nicht', 'no ', 'refuse', 'reject', 'decline', 'deny', 'disagree', 'ablehnen', 'refuser', 'rifiuta', 'rechazar', 'manage', 'settings', 'options', 'customize'];
  const acceptIndicators = ['accept', 'agree', 'allow', 'yes', 'ok', 'got it', 'continue', 'akzeptieren', 'zustimmen', 'accepter', 'accetta', 'aceptar'];

  const isRejectButton = (text) => rejectIndicators.some(p => text.includes(p));
  const isAcceptButton = (text) => acceptIndicators.some(p => text.includes(p)) && !isRejectButton(text);

  const buttons = document.querySelectorAll('button, [role="button"]');
  for (const btn of buttons) {
    const text = (btn.textContent || '').trim().toLowerCase();
    if (!isVisible(btn)) continue;
    const shouldClick = acceptCookies ? isAcceptButton(text) : isRejectButton(text);
    if (shouldClick) { btn.click(); clicked.push('iframe: ' + text.slice(0, 30)); return clicked; }
  }

  const spBtn = acceptCookies
    ? document.querySelector('[title="Accept All"], [title="Accept"], [aria-label*="Accept"]')
    : document.querySelector('[title="Reject All"], [title="Reject"], [aria-label*="Reject"]');
  if (spBtn) { spBtn.click(); clicked.push('Sourcepoint iframe'); return clicked; }

  return clicked;
}`;

// 递归收集所有 frame
function collectFrames(frameTree, frames = []) {
  frames.push({ id: frameTree.frame.id, url: frameTree.frame.url });
  if (frameTree.childFrames) {
    for (const child of frameTree.childFrames) {
      collectFrames(child, frames);
    }
  }
  return frames;
}

await run(async () => {
  const { config, values } = parseCommand({ reject: { type: "boolean" } }, { tab: true });
  const reject = values.reject === true;
  const mode = reject ? "reject" : "accept";
  await withConnection(config, async (cdp) => {
    const sessionId = await attachTab(cdp, config, values.tab);

    // 稍等片刻，让同意弹窗出现
    await new Promise((r) => setTimeout(r, 500));

    log("Trying the main page...");
    let result = await cdp.evaluate(sessionId, `(${COOKIE_DISMISS_SCRIPT})(${!reject})`);

    // 如果没有找到，尝试 iframe
    if (result.length === 0) {
      log("Trying iframes...");
      const frameTree = await cdp.getFrameTree(sessionId);
      for (const frame of collectFrames(frameTree)) {
        if (frame.url === "about:blank" || frame.url.startsWith("javascript:")) continue;
        if (
          frame.url.includes("sp_message") ||
          frame.url.includes("consent") ||
          frame.url.includes("privacy") ||
          frame.url.includes("cmp") ||
          frame.url.includes("sourcepoint") ||
          frame.url.includes("cookie") ||
          frame.url.includes("privacy-mgmt")
        ) {
          log("Trying frame:", frame.url.slice(0, 60));
          const frameResult = await cdp.evaluateInFrame(
            sessionId,
            frame.id,
            `(${IFRAME_DISMISS_SCRIPT})(${!reject})`,
          );
          if (frameResult.length > 0) {
            result = frameResult;
            break;
          }
        }
      }
    }

    if (result.length > 0) {
      console.log(`✓ Closed cookie dialog (${mode}): ${result.join(", ")}`);
    } else {
      console.log(`○ No cookie dialog to ${mode}`);
    }

  });
});
