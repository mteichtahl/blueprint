import { COUNTRY_CODES, PINNED_COUNTRIES } from '@bmg/config/countries';
import {
  getCountryCallingCode,
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min';

/** One country on the consultation form (rev 21). */
export interface Country {
  code: string;
  name: string;
  /** "+61"; absent for the few places with no phone numbering of their own. */
  dial?: string;
}

const names = new Intl.DisplayNames(['en-AU'], { type: 'region', fallback: 'code' });
const nameOf = (code: string) => {
  try {
    return names.of(code) ?? code;
  } catch {
    return code;
  }
};

const dialOf = (code: string) =>
  isSupportedCountry(code) ? `+${getCountryCallingCode(code as CountryCode)}` : undefined;

/** Every country, A to Z by name. */
export const COUNTRIES: Country[] = COUNTRY_CODES.map((code) => {
  const dial = dialOf(code);
  return { code, name: nameOf(code), ...(dial ? { dial } : {}) };
}).sort((a, b) => a.name.localeCompare(b.name, 'en'));

export const PINNED = PINNED_COUNTRIES.map((c) => COUNTRIES.find((x) => x.code === c)!);
export const countryByCode = (code: string) => COUNTRIES.find((c) => c.code === code);

/** Ignores case and accents: "cote" finds Côte d’Ivoire. */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();

/**
 * Countries matching what's typed: by name (any word's start, or anywhere),
 * by code ("AU"), or by calling code ("+61"). Names starting with it first.
 */
export function searchCountries(query: string, list: Country[] = COUNTRIES): Country[] {
  const q = fold(query.trim());
  if (!q) return list;
  const dial = q.replace(/^\+/, '');
  const scored = list
    .map((c) => {
      const n = fold(c.name);
      const score = n.startsWith(q)
        ? 0
        : c.code.toLowerCase() === q
          ? 1
          : n.split(/[\s(),.-]+/).some((w) => w.startsWith(q))
            ? 2
            : n.includes(q)
              ? 3
              : /^\d{1,4}$/.test(dial) && c.dial === `+${dial}`
                ? 4
                : -1;
      return { c, score };
    })
    .filter((x) => x.score >= 0);
  scored.sort((a, b) => a.score - b.score || a.c.name.localeCompare(b.c.name, 'en'));
  return scored.map((x) => x.c);
}

/** The browser's own country, when it says one (en-AU → AU). */
export function browserCountry(languages: readonly string[] = navigator.languages ?? []): string {
  for (const l of languages) {
    const region = /^[a-z]{2,3}-([A-Z]{2})\b/i.exec(l)?.[1]?.toUpperCase();
    if (region && countryByCode(region)) return region;
  }
  return 'AU';
}

/**
 * A mobile number typed for a country, as E.164 (+61412345678), or an error
 * to show. Empty is fine: the number is optional.
 */
export function checkPhone(typed: string, country: string): { e164?: string; error?: string } {
  const t = typed.trim();
  if (!t) return {};
  const parsed = parsePhoneNumberFromString(
    t,
    isSupportedCountry(country) ? (country as CountryCode) : undefined,
  );
  if (!parsed || !parsed.isPossible()) return { error: 'Check your mobile number.' };
  return { e164: parsed.number };
}
