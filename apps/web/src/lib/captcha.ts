/**
 * AWS WAF CAPTCHA for the public consultation form (rev 21). The enquiries
 * API's WAF stops a send that doesn't carry a token from a solved puzzle.
 * The page loads the web ACL's CAPTCHA script (config.json `captcha`), shows
 * the puzzle in place, and sends the form with the script's own fetch, which
 * adds the token.
 */

interface CaptchaOptions {
  apiKey: string;
  onSuccess: (token: string) => void;
  onError?: (err: unknown) => void;
  onLoad?: () => void;
  dynamicWidth?: boolean;
  skipTitle?: boolean;
  defaultLocale?: string;
}

interface WafWindow {
  AwsWafCaptcha?: { renderCaptcha: (el: HTMLElement, o: CaptchaOptions) => void };
  AwsWafIntegration?: { fetch: typeof fetch; hasToken?: () => Promise<boolean> };
}

const wafWindow = () => window as unknown as WafWindow;

let loading: Promise<void> | undefined;

/** Loads the CAPTCHA script once. */
export function loadCaptchaScript(scriptUrl: string): Promise<void> {
  if (wafWindow().AwsWafCaptcha) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = scriptUrl;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = undefined;
      reject(new Error('The check couldn’t load. Refresh the page and try again.'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** Shows the puzzle in `el`; `onSolved` runs once it's solved. */
export function renderCaptcha(
  el: HTMLElement,
  apiKey: string,
  onSolved: () => void,
  onError: (message: string) => void,
): void {
  const w = wafWindow();
  if (!w.AwsWafCaptcha) return onError('The check couldn’t load. Refresh the page and try again.');
  el.replaceChildren();
  w.AwsWafCaptcha.renderCaptcha(el, {
    apiKey,
    onSuccess: () => onSolved(),
    onError: () => onError('That didn’t work. Try the puzzle again.'),
    dynamicWidth: true,
    skipTitle: true,
    defaultLocale: 'en-US',
  });
}

/** The WAF-aware fetch once the script is in; the plain one otherwise. */
export function captchaFetch(): typeof fetch {
  const f = wafWindow().AwsWafIntegration?.fetch;
  return f ? f.bind(wafWindow().AwsWafIntegration) : fetch.bind(window);
}

/**
 * Sends the form. The WAF answers 405 when the token is missing or has run
 * out; that means "solve it again", not a server error.
 */
export async function sendEnquiry(
  body: unknown,
): Promise<{ ok: true; firstName?: string } | { ok: false; captcha: boolean; message: string }> {
  let res: Response;
  try {
    res = await captchaFetch()('/public/enquiries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      ok: false,
      captcha: false,
      message: 'We couldn’t reach Blueprint. Check your connection and try again.',
    };
  }
  if (res.status === 405 || res.headers.get('x-amzn-waf-action') === 'captcha') {
    return { ok: false, captcha: true, message: 'Do the quick check again, then send.' };
  }
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      captcha: false,
      message:
        typeof out.detail === 'string'
          ? out.detail
          : 'Something went wrong. Try again in a minute.',
    };
  }
  return { ok: true, ...(typeof out.firstName === 'string' ? { firstName: out.firstName } : {}) };
}
