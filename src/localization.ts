import deJson from './locales/de.json';
import enJson from './locales/en.json';
import esJson from './locales/es.json';
import frJson from './locales/fr.json';
import jaJson from './locales/ja.json';
import koJson from './locales/ko.json';
import ptBRJson from './locales/pt-BR.json';
import ruJson from './locales/ru.json';
import zhCNJson from './locales/zh-CN.json';

type Dictionary = Record<string, string>;

const en: Dictionary = enJson;

const dictionaries: Record<string, Dictionary> = {
    de: deJson,
    en,
    es: esJson,
    fr: frJson,
    ja: jaJson,
    ko: koJson,
    'pt-BR': ptBRJson,
    ru: ruJson,
    'zh-CN': zhCNJson
};

/** Look up a ui string in the locale chosen by {@link initLocalization}. */
type Localize = (key: string) => string;

const detectLocale = (lang?: string): string => {
    const candidates = [lang, ...(navigator.languages ?? [navigator.language])];
    const keys = Object.keys(dictionaries);
    for (const c of candidates) {
        if (!c) continue;
        const lc = c.toLowerCase();
        const base = lc.split('-')[0];
        // 1. exact tag match (case-insensitive: "DE" → "de", "pt-br" → "pt-BR")
        // 2. base-language match ("fr-CA" → "fr")
        // 3. any region variant sharing the base ("pt" → "pt-BR", "zh" → "zh-CN")
        const match =
            keys.find((k) => k.toLowerCase() === lc) ??
            keys.find((k) => k.toLowerCase() === base) ??
            keys.find((k) => k.toLowerCase().split('-')[0] === base);
        if (match) return match;
    }
    return 'en';
};

// Detect the preferred locale and replace the text of every `[data-i18n]`
// element under `root` with its translation, then return the lookup for that
// locale so ui code can localize strings at runtime. Per instance rather than
// module state, so two viewers on a page can differ. The locale is recorded as
// the root's `lang` so the browser picks fonts for that language (CJK glyph
// selection depends on it) without the viewer touching the document's own.
const initLocalization = (lang: string | undefined, root: HTMLElement): Localize => {
    const locale = detectLocale(lang);
    const current = dictionaries[locale];

    // fall back to English, then the key itself so missing translations are
    // visible rather than blank
    const localize: Localize = (key) => current[key] ?? en[key] ?? key;

    root.lang = locale;
    root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
        el.textContent = localize(el.dataset.i18n);
    });

    return localize;
};

export type { Localize };
export { initLocalization };
